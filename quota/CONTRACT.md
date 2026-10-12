# Norya Quota Subsystem — Module Contracts

Real-time quota tracking for Norya profiles. **Strategy C**: hook the live PTY
output of the running CLI (codex/claude) to update quota instantly, plus periodic
background fetches so quota stays fresh even when the user isn't actively using a CLI.

All modules live in `app/quota/`. They use **Node builtins + injected dependencies only**
(no new npm deps). `node-pty` and `https` are injected where needed so modules stay testable.

The parent process (main.js) wires these into the app. Agents must NOT edit main.js or
test-window.html — only create files under `app/quota/`.

---

## Canonical data shape: `QuotaSnapshot`

This is the SAME shape main.js already caches and the renderer already understands.
Every fetcher/parser MUST emit this exact shape (partials allowed where noted).

```js
{
  // Two rate-limit windows. `primary` = short (≤6h / "5h"), `secondary` = long ("weekly").
  primary:   { used_percent: number, percent_left: number, resets_at: number|null /* unix SECONDS */, resets_at_ms: number|null } | null,
  secondary: { used_percent: number, percent_left: number, resets_at: number|null, resets_at_ms: number|null } | null,

  usedPercent: number,        // max(primary.used_percent, secondary.used_percent)
  percentLeft: number,        // min(primary.percent_left, secondary.percent_left)
  window: 'both'|'5h'|'weekly',
  resetsAt: number|null,      // ms — soonest reset
  used: number|null,          // optional absolute token/message counts (claude may give these)
  total: number|null,

  // status flags (set by fetchers when they detect these conditions)
  loggedOut: boolean|undefined,
  noCredit:  boolean|undefined,
  errorKind: 'auth'|'no-credit'|'timeout'|'error'|null|undefined,

  // provenance — lets the store dedupe/prioritize
  source: 'pty'|'app-server'|'http'|'claude-status'|undefined,
  cli:    'codex'|'claude'|undefined,
  updatedAt: number,          // ms epoch
}
```

Helper that EVERY module producing windows should reuse (copy this into your file — it
matches main.js `parseRateLimitsResponse` semantics exactly):

```js
function buildWindow(usedPercent, resetsAtSec) {
  const up = typeof usedPercent === 'number' ? usedPercent : 0;
  return {
    used_percent: up,
    percent_left: Math.max(0, 100 - up),
    resets_at: resetsAtSec || null,
    resets_at_ms: resetsAtSec ? resetsAtSec * 1000 : null,
  };
}

function rollupSnapshot(primary, secondary, extra = {}) {
  const lefts = [primary, secondary].filter(Boolean).map(w => w.percent_left);
  const useds = [primary, secondary].filter(Boolean).map(w => w.used_percent);
  return {
    primary: primary || null,
    secondary: secondary || null,
    usedPercent: useds.length ? Math.max(...useds) : 0,
    percentLeft: lefts.length ? Math.min(...lefts) : 100,
    window: primary && secondary ? 'both' : (primary ? '5h' : (secondary ? 'weekly' : '5h')),
    resetsAt: primary ? primary.resets_at_ms : (secondary ? secondary.resets_at_ms : null),
    used: null, total: null,
    updatedAt: Date.now(),
    ...extra,
  };
}
```

---

## Injected dependency: `getAccountContext(profileNum)`

main.js provides this. It returns everything needed to spawn a CLI for a profile:

```js
getAccountContext(profileNum) => {
  num: number,
  dir: string,            // account HOME dir (~/.codex-panel/accounts/N)
  env: object,            // full env (HOME per profile) — ready to spawn with
  authMode: 'chatgpt'|'apikey'|'openrouter'|'claude'|null,
  shell: string,          // e.g. '/bin/zsh'
  nvmScript: string,      // path to nvm.sh to source
}
```

Modules that spawn processes accept `getAccountContext` (and `pty` for node-pty) via constructor.

---

## Module 1: `app/quota/pty-parser.js` (Agent 1)

Pure, stateless parsing functions. No spawning. Tolerant regex matching with MULTIPLE
fallback patterns since CLI output formats vary across versions.

```js
// Parse a chunk of accumulated codex TUI/stdout text. Codex prints rate-limit info
// during sessions. Return a partial QuotaSnapshot (any of primary/secondary/flags) or null.
function parseCodexChunk(text) → Partial<QuotaSnapshot> | null

// Parse accumulated claude CLI stdout during a session (rate-limit warnings, usage hints).
function parseClaudeChunk(text) → Partial<QuotaSnapshot> | null

// Parse the FULL output of `claude` `/status` command. This is the reliable claude path.
// Extract subscription/plan, usage limits, reset times. Return a full QuotaSnapshot or null.
function parseClaudeStatus(text) → QuotaSnapshot | null

// Detect a hard rate-limit-hit message in either CLI's output.
function detectRateLimitHit(text, cli /* 'codex'|'claude' */)
  → { hit: boolean, resetsAt: number|null /* ms */, scope: '5h'|'weekly'|'unknown' } | null

module.exports = { parseCodexChunk, parseClaudeChunk, parseClaudeStatus, detectRateLimitHit, buildWindow, rollupSnapshot };
```

**Patterns to handle (be defensive — match several variants, case-insensitive):**
- Percentages: `"23% used"`, `"77% left"`, `"usage: 23%"`, `"5h limit: 77% remaining"`, `"weekly: 100%"`.
- Reset times: `"resets at 18:00"`, `"resets in 2h 30m"`, `"reset 2026-05-28T18:00:00Z"`, ISO timestamps, relative `"in 45 minutes"`.
- Rate-limit hits: `"reached your ... limit"`, `"rate limit"`, `"usage limit reached"`, `"out of"`, `"429"`, `"too many requests"`, `"limit will reset"`.
- ANSI escape codes will be present — strip them first (`text.replace(/\x1b\[[0-9;]*m/g, '')`).
- For relative reset times, convert to absolute ms using `Date.now()`.
- ALWAYS strip ANSI before matching. Return null if nothing matched (don't guess).

**Tests:** `app/quota/test/pty-parser.test.js` — plain node `assert` script with fixture strings
for each pattern (codex with %, claude /status sample, rate-limit-hit messages, ANSI-wrapped text,
relative & absolute reset times, "nothing matches → null"). Print PASS/FAIL summary, exit 0/1.

NOTE: You don't have the exact real CLI output formats. Make the parser robust to many
plausible formats and document each pattern with a comment + example. Capture the raw matched
substring in a `_raw` field on the partial for debugging.

---

## Module 2: `app/quota/claude-status.js` (Agent 2)

`ClaudeStatusFetcher` — spawns a HIDDEN interactive `claude` PTY, sends `/status`, captures
the output, parses it, returns a QuotaSnapshot, then kills the PTY. Claude has no app-server
API, so this is the reliable claude quota path (used at boot, periodically, and on-demand).

```js
class ClaudeStatusFetcher {
  constructor({ getAccountContext, pty, parser /* the pty-parser module */, logFn });
  // Spawn claude interactively in the profile's env, write '/status\n', wait for output to
  // settle (~quiet for 1.2s OR a known end marker), parse via parser.parseClaudeStatus,
  // kill PTY. Returns QuotaSnapshot with source:'claude-status', cli:'claude'.
  // On failure (timeout, claude not installed, logged out): return a snapshot with the
  // appropriate flag (loggedOut / errorKind) instead of throwing.
  async fetch(profileNum, { timeoutMs = 15000 } = {}) → QuotaSnapshot
}
module.exports = ClaudeStatusFetcher;
```

**Spawn details:** Use injected `pty.spawn(shell, ['-l','-c', initCmd], { cwd: ctx.dir, env: ctx.env, cols:120, rows:40 })`
where `initCmd` sources nvm + brew shellenv + runs `claude` (interactive, NO `-p`). The account
env already sets HOME so claude reads the right profile. After spawn, wait ~2.5s for claude to
boot its TUI, then `proc.write('/status\r')`. Accumulate `onData`. Consider output "settled"
after 1.2s of no new data following the first time you see status-like content (a '%' or
'limit' or 'reset' or 'subscription' keyword), then parse + kill. Hard timeout `timeoutMs`.

Detect logged-out: if output contains "not logged in" / "/login" / "log in" prompts, return
`{ loggedOut:true, errorKind:'auth', source:'claude-status', cli:'claude', updatedAt:Date.now() }`.

ALWAYS kill the PTY (proc.kill()) in a finally. Never leave a zombie claude.

**Tests:** `app/quota/test/claude-status.test.js` — inject a FAKE `pty` (a stub that emits
canned `/status` data via the onData callback after write) and a stub parser; assert fetch()
returns the parsed snapshot and that the fake proc.kill() was called. Also test the
logged-out path and the timeout path (fake pty that never emits). Plain node assert, PASS/FAIL.

---

## Module 3: `app/quota/codex-http.js` (Agent 3)

`CodexQuotaFetcher` — fetches codex (ChatGPT) quota. Codex HAS a reliable JSON-RPC path via
`codex app-server`. Extract main.js's existing logic into a clean module. This is the
authoritative codex number (the PTY parser only supplements between fetches).

```js
class CodexQuotaFetcher {
  constructor({ getAccountContext, childSpawn, https, logFn });
  // Spawn `codex app-server --listen stdio://`, JSON-RPC initialize (id:1) then
  // account/rateLimits/read (id:2), parse via the same logic as main.js
  // parseRateLimitsResponse, return QuotaSnapshot (source:'app-server', cli:'codex').
  // 20s timeout. On auth failure, verify token via HTTPS GET
  // https://chatgpt.com/backend-api/codex/models (401 → loggedOut, 402 → noCredit),
  // return snapshot with flags. Never throw — return a flagged snapshot.
  async fetch(profileNum, { timeoutMs = 20000 } = {}) → QuotaSnapshot
}
module.exports = CodexQuotaFetcher;
```

**Reference — exact codex app-server flow (copy this logic):**
```
initCmd = `[ -s "${nvmScript}" ] && . "${nvmScript}"; eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; exec codex app-server --listen stdio://`
proc = childSpawn(shell, ['-l','-c', initCmd], { stdio:['pipe','pipe','pipe'], cwd: ctx.dir, env: ctx.env })
// after 500ms, write: {jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'codex-panel',version:'1.0'}}}\n
// on id:1 success → write: {jsonrpc:'2.0',id:2,method:'account/rateLimits/read',params:{}}\n
// on id:2 → parse msg.result.rateLimits
```

**parseRateLimitsResponse (replicate exactly):** rateLimits has `.primary` and/or `.secondary`,
each with `{ usedPercent, resetsAt /* unix sec */, windowDurationMins }`. The window with
`windowDurationMins <= 360` is the short ("5h") window → snapshot.primary; the other → secondary.
Use buildWindow(usedPercent, resetsAt) and rollupSnapshot(). Import these from `./pty-parser`
(Agent 1 exports them) OR copy them locally if you prefer zero coupling — copying is fine.

**Token verify on auth failure:** GET `https://chatgpt.com/backend-api/codex/models?client_version=0.133.0`
with `Authorization: Bearer <access_token>` read from `${ctx.dir}/.codex/auth.json` (auth.tokens.access_token).
401 → loggedOut:true,errorKind:'auth'. 402 → noCredit:true,errorKind:'no-credit'. timeout 4s.

**Tests:** `app/quota/test/codex-http.test.js` — inject a FAKE childSpawn returning a stub proc
whose stdout emits canned JSON-RPC responses; assert fetch() returns a snapshot with correct
primary/secondary. Test the auth-failure → token-verify path with a fake https returning 401.
Plain node assert, PASS/FAIL.

---

## Module 4: `app/quota/quota-store.js` (Agent 4)

`QuotaStore` — single source of truth for current quota per profile. Holds in-memory state,
persists to the cache file, merges signals from multiple sources, emits 'change' events.

```js
const { EventEmitter } = require('events');
class QuotaStore extends EventEmitter {
  constructor({ cachePath /* QUOTA_CACHE_PATH */, fs });
  load();                              // read cache file into memory (call once at start)
  get(profileNum) → QuotaSnapshot|null;
  getAll() → { [num]: QuotaSnapshot }; // clone of full cache (for quota-get IPC)
  // Merge a (possibly partial) snapshot for a profile. Newer/more-authoritative data wins.
  // Preserves manualReset and other sticky fields. Persists to cache. Emits 'change' {num, snapshot}.
  update(profileNum, partial) → QuotaSnapshot;
  // Clear status flags after a successful re-login (used by quota-refresh).
  clearFlags(profileNum);              // delete loggedOut/noCredit/errorKind, emit 'change'
}
module.exports = QuotaStore;
```

**Merge rules:**
- Source priority (higher overrides on conflict within ~same time): `claude-status`/`app-server`/`http` (authoritative) > `pty` (supplemental). But ALWAYS take the newest `updatedAt` for window data; pty can update percentages live. Concretely: merge field-by-field, but if incoming.source==='pty' and existing has authoritative source updated <30s ago, only let pty update `primary`/`secondary`/`usedPercent`/`percentLeft` (the live numbers), not flags.
- `manualReset` (existing sticky field) must be preserved across updates.
- Setting `loggedOut:true` clears `noCredit` and vice-versa (mutually exclusive), matching main.js.
- Always set `updatedAt: Date.now()` on the merged result.
- Persist via injected `fs` (writeFileSync JSON, mkdir -p parent). Debounce writes by 250ms to avoid thrashing on rapid pty updates (optional but nice).

**Cache file shape:** `{ [String(num)]: QuotaSnapshot }` — exactly what main.js readQuotaCache/writeQuotaCache use.

**Tests:** `app/quota/test/quota-store.test.js` — temp cache file; test update→get, getAll clone,
pty-vs-authoritative merge priority, manualReset preservation, loggedOut/noCredit mutual exclusion,
clearFlags, persistence across reload. Plain node assert, PASS/FAIL.

---

## Module 5: `app/quota/index.js` (Agent 5)

`QuotaManager` — the orchestrator main.js talks to. Ties parser + fetchers + store together.

```js
const QuotaStore = require('./quota-store');
const CodexQuotaFetcher = require('./codex-http');
const ClaudeStatusFetcher = require('./claude-status');
const parser = require('./pty-parser');

class QuotaManager extends require('events').EventEmitter {
  constructor({ getAccountContext, cachePath, childSpawn, https, pty, fs, logFn });
  // Instantiates store (load()), codexFetcher, claudeFetcher. Re-emits store 'change' as 'quota'.

  start();                       // store.load()
  get(profileNum);               // store.get
  getAll();                      // store.getAll

  // Live PTY hook — main.js calls this from ptyProcess.onData for codex/claude PTYs.
  // Accumulates a rolling text buffer per profile (last ~8KB), runs the appropriate parser,
  // and if it finds quota signals OR a rate-limit hit, store.update(...). Cheap; safe to call often.
  feedPty(profileNum, cli /* 'codex'|'claude' */, chunk);

  // Authoritative fetch for one profile. cli inferred from authMode if not given:
  //   chatgpt/apikey → codex fetcher; claude → claude-status fetcher; openrouter → skip (no quota).
  async refresh(profileNum, { cli, force } = {}) → QuotaSnapshot|null;

  // Fetch all given profiles in parallel (used at boot). profiles = array of {num, authMode}.
  async refreshAll(profiles) → void;

  clearFlags(profileNum);        // store.clearFlags (after re-login)
}
module.exports = QuotaManager;
```

**feedPty details:** keep `Map<num, string>` rolling buffers, cap each at 8KB
(`buf = (buf+chunk).slice(-8192)`). For codex use parser.parseCodexChunk; for claude
parser.parseClaudeChunk. Also run parser.detectRateLimitHit — if hit, update with
`usedPercent:100, percentLeft:0` for the hit scope window + errorKind null (it's a limit, not error).
Tag updates `source:'pty'`. Throttle parsing to at most once per 500ms per profile.

**refresh details:** dispatch to the right fetcher by authMode/cli, then store.update(result).
Return the merged snapshot. Guard against concurrent refresh of the same profile (in-flight map).

**Tests:** `app/quota/test/index.test.js` — inject stub fetchers + a real QuotaStore (temp cache);
test feedPty with codex/claude fixtures updates store; test refresh dispatches to correct fetcher
by authMode; test refreshAll runs in parallel; test 'quota' event re-emission. Plain node assert.

---

## Integration note (parent does this, FYI for agents)

main.js will:
- Build `getAccountContext` from existing `buildAccountEnv` + `readProfile`.
- `quotaManager.feedPty(profileNum, cli, data)` inside `ptyProcess.onData`.
- `quotaManager.refreshAll(profiles)` at `app.whenReady` (parallel boot fetch).
- Periodic `setInterval` re-fetch (~30-60s) for visible profiles.
- IPC `quota-get` → `quotaManager.getAll()`; `quota-refresh` → `quotaManager.refresh(num, {force:true})`.
- Forward `quotaManager.on('quota', ({num, snapshot}) => testWindow.send('quota-updated', {num, ...snapshot}))`.

So agents: keep the public method signatures EXACTLY as specified above.


---

## Adendo 2026-09-08 — um snapshot por (perfil, provider)

**Chaves do store.** `"12:codex"`, `"14:claude"`, `"7:grok"` — uma por (perfil,
provider). A chave legada `"12"` continua sendo gravada pelo `QuotaManager` como
**espelho do provider padrão** (`authMode`): é ela que `getProfileHealth`, o cartão de
perfil e os pickers leem. Ninguém mais escreve nela. O evento `change`/`quota` carrega
`{ key, num, provider, snapshot }` (`provider` null na chave legada).

**Campos novos no `QuotaSnapshot`** (aditivos, opcionais):

```js
provider:     'codex'|'claude'|'grok',
plan:         string|null,    // 'plus' | 'max' … cru, como a API devolve
planLabel:    string|null,    // 'Plus' | 'Max 5x' — derivado, para a UI
identity:     string|null,    // e-mail (Codex) | 'conta do Mac' | 'token isolado'
windows: [{ id: 'session'|'weekly'|'weekly:<modelo>'|'extra', label, used_percent,
            percent_left, resets_at, resets_at_ms, severity? }],   // TODAS, em ordem
credits:      { hasCredits, unlimited, balance } | null,            // Codex
resetCredits: number|null,                                          // Codex: resets grátis
extraUsage:   { enabled, utilization, used, limit, currency, decimals } | null, // Claude
usageCredits: { enabled, percent, used, limit, balance } | null,    // Claude ("spend")
readAt:       number,         // ms — última LEITURA boa (updatedAt muda até nos erros)
tokenRejected: boolean,       // claude-http: 401/403 → o manager sobe a TUI uma vez
source:       … | 'claude-http' | 'grok-usage',   // ambas autoritativas
```

`primary`/`secondary`/`usedPercent`/`percentLeft` continuam preenchidos a partir de
`windows` (`pty-parser.snapshotFromWindows`) — `usedPercent` é o máximo de TODAS as
janelas, inclusive as semanais por modelo.

**Fontes.** Claude: `claude-http.js` (GET `api.anthropic.com/api/oauth/usage`, o mesmo do
`/usage` do CLI) é a primária; `claude-status.js` (TUI) só quando o HTTP recusa o token.
Codex: `codex-http.js` faz `account/rateLimits/read` + `account/read` na mesma sessão.
Grok: `grok-usage.js` por perfil (env do perfil), só sob demanda.

**Quem decide o que medir.** `agents/providers.quotaProvidersFor(profile, status)` →
provider padrão sempre; os outros só com credencial própria do perfil. O Claude do
Keychain é global e só entra no perfil cujo padrão é claude.
