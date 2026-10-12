'use strict';

/**
 * platform.js — a ÚNICA camada que sabe se o Norya está no macOS ou no Windows.
 *
 * Regra dura: nenhum outro arquivo pode testar `process.platform` para decidir
 * shell, PATH, aspas ou socket. Se um `=== 'win32'` aparecer fora daqui, a
 * próxima diferença de plataforma vai nascer espalhada de novo — foi assim que
 * `/bin/zsh` acabou cravado em seis lugares.
 *
 * Tudo é construído por `makePlatform({ platform, env, homedir, exists })`, e o
 * módulo exporta uma instância default ligada ao processo real. É o que permite
 * testar o comportamento Windows a partir do Mac (test/platform.test.js) sem
 * mock global e sem depender da máquina onde o teste roda.
 *
 * Node builtins apenas — mesmo contrato do quota/CONTRACT.md.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

/** PowerShell: string literal entre aspas simples; a aspa se escapa dobrando. */
function quotePwsh(s) {
  return `'${String(s).replace(/'/g, `''`)}'`;
}

/** POSIX: fecha, escapa a aspa, reabre. */
function quotePosix(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Windows: escapa UM argumento para a linha de comando de um programa nativo
 * (regras do CommandLineToArgvW / MSVCRT, que node, claude.exe e codex leem).
 *
 * Por que existe: o PowerShell 5.1 — e o 7.x quando o alvo é um `.cmd`, que é
 * como o npm instala `claude`/`codex` — NÃO escapa a aspa dupla de dentro de
 * um argumento ao montar a linha do processo filho. `--settings '{"a":1}'`
 * chegava à CLI como `{a:1}` ou partido em vários argumentos. Com
 * `$PSNativeCommandArgumentPassing='Legacy'` (ver `shellArgs`) os dois
 * PowerShell repassam o texto como está, envolvendo em aspas só quando há
 * espaço — e este escape é o que torna esse texto correto:
 *   - `"` vira `\"`, dobrando as barras que vinham logo antes dela;
 *   - barras no FIM de um argumento com espaço dobram (senão escapariam a aspa
 *     de fechamento que o PowerShell acrescenta).
 * Barra no meio de caminho (`C:\Users\x`) fica intacta.
 */
function escapeWinNativeArg(s) {
  const str = String(s);
  let out = '';
  let barras = 0;
  for (const ch of str) {
    if (ch === '\\') { barras++; continue; }
    if (ch === '"') { out += '\\'.repeat(barras * 2 + 1) + '"'; barras = 0; continue; }
    out += '\\'.repeat(barras) + ch;
    barras = 0;
  }
  return out + '\\'.repeat(/\s/.test(str) ? barras * 2 : barras);
}

/** Windows: literal do PowerShell (aspas simples) de um argumento já escapado para o nativo. */
function quoteWinArg(s) {
  return quotePwsh(escapeWinNativeArg(s));
}

/**
 * Prefixo de todo `-Command` no Windows: o PowerShell 7.3+ passou a escapar
 * aspas sozinho (modo `Windows`/`Standard`), o 5.1 não — e o 7.x volta ao
 * jeito antigo para `.cmd`. Fixar `Legacy` faz os três casos se comportarem
 * igual, e o `escapeWinNativeArg` acima é escrito para esse modo. No 5.1 a
 * variável não existe: a atribuição é inofensiva.
 */
const PS_NATIVE_LEGACY = "$PSNativeCommandArgumentPassing='Legacy'";

const QUOTERS = { posix: quotePosix, pwsh: quoteWinArg };

function makePlatform(opts = {}) {
  const platform = opts.platform || process.platform;
  const env      = opts.env || process.env;
  const isWin    = platform === 'win32';
  const isMac    = platform === 'darwin';
  const p        = isWin ? path.win32 : path.posix;
  const exists   = opts.exists || (f => { try { return fs.existsSync(f); } catch { return false; } });
  const home     = opts.homedir
    || (isWin ? (env.USERPROFILE || env.HOMEDRIVE && env.HOMEPATH && (env.HOMEDRIVE + env.HOMEPATH) || os.homedir())
              : (os.homedir()));

  const pathSep = isWin ? ';' : ':';

  // ── Shell do PTY ────────────────────────────────────────────────────────────
  //
  // Windows: PowerShell, não `cmd`. O `cmd` não tem como compor `A; B; C` numa
  // linha só sem `&&` (que aborta na primeira falha) e trata aspas de um jeito
  // que nenhuma CLI de agente espera. O PowerShell usa `;` como separador — a
  // mesma forma que o resto do código já monta — e as aspas simples são
  // literais, então `quotePwsh` basta.
  //
  // `pwsh.exe` (PowerShell 7) na frente porque tem UTF-8 por padrão e um
  // ConPTY muito melhor comportado; o 5.1 de fábrica é o fallback garantido.
  const WIN_PS_FALLBACK = p.join(env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  function winPwshCandidates() {
    const pf   = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      p.join(pf, 'PowerShell', '7', 'pwsh.exe'),
      p.join(pf86, 'PowerShell', '7', 'pwsh.exe'),
      p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'),
        'Microsoft', 'WindowsApps', 'pwsh.exe'),
    ];
  }

  function shellBin() {
    if (!isWin) return env.SHELL || '/bin/zsh';
    for (const c of winPwshCandidates()) if (exists(c)) return c;
    return WIN_PS_FALLBACK;
  }

  /**
   * argv para rodar UMA string de comando no shell.
   *
   * POSIX mantém `-l -c` (shell de login) — é o que carrega o ambiente do
   * usuário. No Windows não existe "login shell": o ambiente vem do registro e
   * já foi herdado pelo processo, então `-NoProfile` é o certo (o profile do
   * usuário costuma imprimir banners que sujam a TUI) e o PATH das CLIs é
   * montado por nós em `agentPathDirs()`.
   */
  function shellArgs(cmd) {
    if (!isWin) return ['-l', '-c', cmd];
    return ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${PS_NATIVE_LEGACY}; ${cmd}`];
  }

  /** Variante não-interativa (detecção de CLIs, sondas de quota). */
  function shellArgsNonInteractive(cmd) {
    if (!isWin) return ['-lc', cmd];
    return shellArgs(cmd);
  }

  const quoteStyle = isWin ? 'pwsh' : 'posix';
  const quote = QUOTERS[quoteStyle];

  /** Junta comandos numa linha só. `;` serve nos dois shells. */
  function joinCmds(list) {
    return list.filter(Boolean).join('; ');
  }

  // ── PATH onde as CLIs de agente vivem ───────────────────────────────────────
  //
  // macOS: lista histórica, verbatim (mudar a ordem aqui muda qual binário
  // vence — já houve um caso de `codex` do nvm perdendo para um do brew).
  // Windows: os lugares reais onde npm global, nvm-windows, scoop, bun, pipx e
  // o instalador nativo do claude põem executáveis.
  function agentPathDirs() {
    if (!isWin) {
      return [
        p.join(home, '.local', 'bin'),
        p.join(home, '.grok', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
    }
    const appData  = env.APPDATA      || p.join(home, 'AppData', 'Roaming');
    const localApp = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    const progFiles = env.ProgramFiles || 'C:\\Program Files';
    return [
      p.join(home, '.local', 'bin'),          // instalador nativo do claude, pipx
      p.join(home, '.claude', 'local'),       // claude local install
      p.join(home, '.grok', 'bin'),
      p.join(home, '.bun', 'bin'),
      p.join(home, 'scoop', 'shims'),
      p.join(appData, 'npm'),                 // npm -g
      p.join(appData, 'Python', 'Scripts'),   // pip --user (aider)
      p.join(localApp, 'Microsoft', 'WindowsApps'),
      p.join(progFiles, 'nodejs'),            // nvm-windows aponta o symlink aqui
      p.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
    ];
  }

  /**
   * Prelúdio de shell que torna as CLIs encontráveis.
   *
   * No macOS ele existe porque `nvm` e `brew` só entram no PATH via script, e
   * um app aberto pelo Finder herda um PATH mínimo do launchd.
   * No Windows NÃO há prelúdio: o PATH é montado em Node e injetado no `env` do
   * PTY (`prependPath`), que é mais barato e não depende de o shell cooperar.
   */
  function agentShellPrelude({ nvmDir } = {}) {
    if (isWin) return '';
    const nvmScript = p.join(nvmDir || p.join(home, '.nvm'), 'nvm.sh');
    return joinCmds([
      `[ -s "${nvmScript}" ] && source "${nvmScript}"`,
      'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null',
      `export PATH="${agentPathDirs().join(pathSep)}:$PATH"`,
    ]);
  }

  /**
   * Prepende diretórios ao PATH de um objeto de env, in-place.
   *
   * No Windows a variável de ambiente é case-insensitive, mas o OBJETO que
   * passamos ao node-pty não é: se sobrarem `Path` e `PATH`, o processo filho
   * pode enxergar só um deles — e não dá para prever qual. Então normalizamos
   * para uma chave só.
   */
  function prependPath(envObj, ...dirs) {
    const flat = dirs.flat().filter(Boolean);
    let atual = '';
    if (isWin) {
      for (const k of Object.keys(envObj)) {
        if (k.toLowerCase() === 'path') {
          if (envObj[k]) atual = atual ? atual + pathSep + envObj[k] : envObj[k];
          delete envObj[k];
        }
      }
    } else {
      atual = envObj.PATH || '';
    }
    envObj.PATH = flat.concat(atual ? [atual] : []).join(pathSep);
    return envObj;
  }

  // ── IPC local ───────────────────────────────────────────────────────────────
  //
  // No Windows não existe socket Unix utilizável pelo `net` do Node da mesma
  // forma; o equivalente é o named pipe, que o `net.createServer().listen()`
  // aceita com o MESMO código desde que o caminho seja `\\.\pipe\...`.
  // A ACL default de um named pipe já limita ao usuário da sessão, então o
  // `chmod 0600` do lado POSIX não tem (nem precisa de) equivalente.
  //
  // O namespace de named pipes é da MÁQUINA, não do usuário: dois usuários do
  // Windows logados ao mesmo tempo disputariam `norya-open-u` (o segundo Norya
  // ganhava EADDRINUSE e ficava sem auto-open/MCP). O nome do usuário entra no
  // pipe; no POSIX o socket já é por uid (`open-<uid>`) ou vive no TMPDIR dele.
  function userTag() {
    let u = opts.username || env.USERNAME || '';
    if (!u) { try { u = os.userInfo().username; } catch { u = 'u'; } }
    return String(u).replace(/[^A-Za-z0-9._-]/g, '_') || 'u';
  }

  /** Sufixo por usuário dos sockets de main.js: uid no POSIX; no Windows o usuário já vai no pipe. */
  function uidTag() {
    if (isWin) return 'u';
    return typeof process.getuid === 'function' ? String(process.getuid()) : 'u';
  }

  // Pasta PRIVADA dos sockets no POSIX. `/tmp/norya-*.sock` era previsível num
  // diretório de todos: outro usuário da máquina podia criar o caminho antes e
  // receber a URL de OAuth (ou fazer o listen falhar). Agora: <tmp>/norya-<uid>,
  // 0700, dono conferido, nunca symlink — fail-closed se alguém plantou algo.
  let _runDir = opts.runDir || null;
  function privateRunDir() {
    if (_runDir) return _runDir;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const dir = p.join(opts.tmpdir || os.tmpdir(), `norya-${uid == null ? 'u' : uid}`);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`norya: ${dir} não é uma pasta própria`);
    if (uid != null && st.uid !== uid) throw new Error(`norya: ${dir} pertence a outro usuário`);
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    _runDir = dir;
    return dir;
  }

  function ipcEndpoint(nome, { dir } = {}) {
    if (isWin) return `\\\\.\\pipe\\norya-${userTag()}-${nome}`;
    return p.join(dir || privateRunDir(), `norya-${nome}.sock`);
  }

  function isPipe(caminho) {
    return typeof caminho === 'string' && caminho.startsWith('\\\\.\\pipe\\');
  }

  /** chmod que vira no-op onde o conceito não existe. */
  function restrict(caminho, mode, fsImpl = fs) {
    if (isWin) return false;
    try { fsImpl.chmodSync(caminho, mode); return true; } catch { return false; }
  }

  /** Remove um endpoint de IPC morto. Named pipe some com o processo. */
  function unlinkEndpoint(caminho, fsImpl = fs) {
    if (isWin || isPipe(caminho)) return;
    try { fsImpl.unlinkSync(caminho); } catch {}
  }

  // ── Isolamento de perfil ────────────────────────────────────────────────────
  //
  // O truque que sustenta várias contas do mesmo agente é dar um HOME por
  // perfil. No Windows quem manda é `USERPROFILE` — `os.homedir()` do Node lê
  // ele, e é sob ele que codex (`.codex`) e claude (`.claude`) gravam.
  // `APPDATA`/`LOCALAPPDATA` ficam REAIS de propósito: redirecioná-los moveria
  // o cache do npm e o prefixo global junto, e a CLI sumiria do PATH.
  function profileHomeEnv(dir) {
    if (!isWin) return { HOME: dir };
    const out = { HOME: dir, USERPROFILE: dir };
    const raiz = p.parse(dir).root;              // 'C:\'
    if (raiz) {
      out.HOMEDRIVE = raiz.replace(/\\$/, '');   // 'C:'
      out.HOMEPATH  = dir.slice(raiz.length - 1) || '\\';
    }
    return out;
  }

  // ── Shim de `open` ──────────────────────────────────────────────────────────
  function openShimDirName() {
    return isWin ? 'open-shim-win' : 'open-shim';
  }
  function openShimBinName() {
    return isWin ? 'norya-open.cmd' : 'open';
  }
  function authOpenBinName() {
    return isWin ? 'norya-auth-open.cmd' : 'norya-auth-open';
  }

  /** `command -v` de cada plataforma, para a detecção de CLIs. */
  function probeCommand(id, bin) {
    if (isWin) {
      return `$p=(Get-Command ${bin} -ErrorAction SilentlyContinue | ` +
             `Select-Object -First 1 -ExpandProperty Source); ` +
             `if ($p) { "${id}\`t$p" }`;
    }
    return `p=$(command -v ${bin} 2>/dev/null) && printf '%s\\t%s\\n' ${id} "$p"`;
  }

  /**
   * Prelúdio MÍNIMO das sondas de quota (codex app-server, grok models).
   *
   * Diferente do `agentShellPrelude`: aqui NÃO mexemos na ordem do PATH. As
   * sondas rodam há meses no macOS com exatamente estas duas linhas, e
   * prepender diretórios mudaria QUAL binário `codex` é medido quando existe
   * mais de um (nvm e brew). No Windows não há prelúdio nenhum.
   */
  function probePrelude({ nvmDir } = {}) {
    if (isWin) return '';
    const nvmScript = p.join(nvmDir || p.join(home, '.nvm'), 'nvm.sh');
    return [
      `[ -s "${nvmScript}" ] && . "${nvmScript}"`,
      'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null',
    ].join('; ');
  }

  /** `exec` substitui o shell pelo processo filho. PowerShell não tem isso. */
  const execPrefix = isWin ? '' : 'exec ';

  /** Onde um PTY descartável pode nascer (sondas de quota). */
  function scratchCwd() {
    return isWin ? (env.TEMP || env.TMP || os.tmpdir()) : '/tmp';
  }

  // ── Processos filhos ────────────────────────────────────────────────────────
  //
  // Electron é app de JANELA: no Windows, todo filho de console (git.exe,
  // powershell.exe, node.exe, taskkill) que nasce sem `windowsHide` abre uma
  // janela preta piscando. No POSIX a opção não existe e é ignorada.

  /** Opções de spawn com a janela de console escondida (quem chama pode sobrescrever). */
  function spawnOpts(o) {
    return Object.assign({ windowsHide: true }, o || {});
  }

  /**
   * `child_process` com `windowsHide: true` em spawn/exec* — para o main.js,
   * que tem dezenas de chamadas de git. No POSIX devolve o próprio módulo.
   * Aceita as formas (file, args?, options?, cb?) e (cmd, options?, cb?).
   */
  function windowless(cp) {
    if (!isWin) return cp;
    const wrap = (fn) => function (...a) {
      const i = Array.isArray(a[1]) ? 2 : 1;
      if (a[i] && typeof a[i] === 'object') a[i] = spawnOpts(a[i]);
      else if (a[i] == null && a.length > i) a[i] = spawnOpts();
      else a.splice(i, 0, spawnOpts());
      return fn.apply(cp, a);
    };
    const out = Object.assign({}, cp);
    for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) if (typeof cp[k] === 'function') out[k] = wrap(cp[k]);
    // exec/execSync: (cmd, options?, cb?) — o slot de options é sempre o 1.
    for (const k of ['exec', 'execSync']) {
      if (typeof cp[k] !== 'function') continue;
      const fn = cp[k];
      out[k] = function (cmd, o, ...rest) {
        if (typeof o === 'function') return fn.call(cp, cmd, spawnOpts(), o, ...rest);
        return fn.call(cp, cmd, spawnOpts(o), ...rest);
      };
    }
    return out;
  }

  /**
   * `detached` de um filho cujo grupo inteiro será morto depois. No POSIX cria
   * o grupo (kill(-pid) leva junto o que o shell deixar). No Windows `detached`
   * dá ao filho um CONSOLE PRÓPRIO — uma janela nova — e não cria grupo nenhum;
   * lá a árvore se mata com taskkill /T.
   */
  const detachGroup = !isWin;

  /**
   * Mata o processo E os filhos dele.
   *
   * POSIX: `process.kill(-pid, signal)` — o grupo criado por `detachGroup`
   * (lança se o grupo não existe; quem chama já trata).
   * Windows: `proc.kill()` derruba só o processo de cima. Com o chat indo direto
   * para `node.exe cli.js`, isso deixaria órfãos os shells do Bash tool, os
   * MCPs e o `codex.exe` que o `codex.js` sobe. `taskkill /T /F` leva a árvore;
   * não existe "SIGTERM educado" para programa de console, então é sempre /F.
   */
  function killTreeCommand(pid) {
    if (!isWin) return null;
    return {
      file: p.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      args: ['/PID', String(pid), '/T', '/F'],
    };
  }

  function killTree(pid, signal = 'SIGTERM', deps = {}) {
    if (!pid) return false;
    if (!isWin) {
      if (deps.kill) deps.kill(-pid, signal);
      else process.kill(-pid, signal);
      return true;
    }
    const c = killTreeCommand(pid);
    const run = deps.execFile || opts.execFile || require('child_process').execFile;
    run(c.file, c.args, spawnOpts({ timeout: 5000 }), () => {});
    return true;
  }

  // ── Achar e lançar um executável SEM shell ─────────────────────────────────
  //
  // O modo chat fala JSON por stdin/stdout. Passar isso por PowerShell + o
  // wrapper `.cmd`/`.ps1` do npm é pedir para o PowerShell re-codificar a saída
  // nativa na code page do console e para o `cmd` reinterpretar `&|^%` dos
  // argumentos. No Windows o chat sobe a CLI direto (args em array, sem shell).
  // Node recusa `.cmd`/`.bat` sem shell (EINVAL, desde a CVE-2024-27980) e
  // `.ps1` nem é executável — então o shim do npm é LIDO e vira
  // `node.exe <pacote>/cli.js`, que é exatamente o que ele faria.

  /** Procura `name` nos diretórios de `envPath`. Windows: .exe ganha do shim .cmd/.ps1. */
  function which(name, envPath) {
    if (!name) return null;
    if (p.isAbsolute(name)) return exists(name) ? name : null;
    const dirs = String(envPath == null ? (env.PATH || env.Path || '') : envPath).split(pathSep).filter(Boolean);
    const exts = (!isWin || p.extname(name)) ? [''] : ['.exe', '.com', '.cmd', '.bat', '.ps1'];
    for (const d of dirs) {
      for (const e of exts) {
        const f = p.join(d, name + e);
        if (exists(f)) return f;
      }
    }
    return null;
  }

  // Alvo JS dentro do shim do npm (cmd-shim):
  //   .cmd  →  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*   (npm ≥7)
  //            "%~dp0\node_modules\...\cli.js" %*                   (npm 6)
  //   .ps1  →  & "$basedir/node$exe"  "$basedir/node_modules/.../cli.js" $args
  const SHIM_CMD_JS = /"%~?dp0%?\\([^"%]+?\.(?:c?js|mjs))"/i;
  const SHIM_PS1_JS = /"\$basedir[\\/]([^"$]+?\.(?:c?js|mjs))"/i;

  /**
   * Como lançar `bin` com spawn SEM shell: `{ file, args }` (args vão ANTES dos
   * da CLI) ou null quando não dá. POSIX: o próprio binário.
   */
  function runnable(bin, { envPath, readFile } = {}) {
    if (!bin) return null;
    if (!isWin) return { file: bin, args: [] };
    const ext = p.extname(bin).toLowerCase();
    if (ext === '.exe' || ext === '.com') return { file: bin, args: [] };
    const base = ['.cmd', '.bat', '.ps1'].includes(ext) ? bin.slice(0, -ext.length) : bin;
    const dir = p.dirname(bin);
    const ler = readFile || opts.readFile || (f => fs.readFileSync(f, 'utf8'));
    for (const [shim, re] of [[base + '.cmd', SHIM_CMD_JS], [base + '.ps1', SHIM_PS1_JS]]) {
      if (!exists(shim)) continue;
      let src;
      try { src = ler(shim); } catch { continue; }
      const m = String(src).match(re);
      if (!m) continue;
      const script = p.join(dir, m[1].replace(/\//g, '\\'));
      const nodeLocal = p.join(dir, 'node.exe');      // o shim prefere o node ao lado dele
      const node = exists(nodeLocal) ? nodeLocal : which('node.exe', envPath);
      return node ? { file: node, args: [script] } : null;
    }
    if (exists(base + '.exe')) return { file: base + '.exe', args: [] };
    return null;
  }

  /**
   * Como subir uma CLI em modo chat (stdio JSON).
   *
   * POSIX: o shell de login de sempre (`zsh -l -c '<prelúdio>; exec claude …'`).
   * Windows: direto, se o binário for resolvível; senão o PowerShell com a
   * console em UTF-8, como último recurso.
   *
   * @param {{shell:string, initCmd:string, argv?:{bin:string,args:string[]}, envPath?:string}} o
   * @returns {{file:string, args:string[], direct:boolean}}
   */
  function chatLaunch({ shell, initCmd, argv, envPath, readFile } = {}) {
    if (isWin && argv && argv.bin) {
      const bin = which(argv.bin, envPath);
      const r = bin && runnable(bin, { envPath, readFile });
      if (r) return { file: r.file, args: r.args.concat(argv.args || []), direct: true };
      const utf8 = 'try { $e=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$e; ' +
        '[Console]::OutputEncoding=$e; $OutputEncoding=$e } catch {}';
      return { file: shell || shellBin(), args: shellArgs(`${utf8}; ${initCmd}`), direct: false };
    }
    return { file: shell || shellBin(), args: shellArgs(initCmd), direct: false };
  }

  // ── Hook do Claude ──────────────────────────────────────────────────────────

  /** Nome do binário do node na plataforma. */
  const nodeBinName = isWin ? 'node.exe' : 'node';

  /**
   * Linha de comando do hook (interpretador + script).
   *
   * POSIX: aspas simples de sempre. Windows: o Claude roda o hook por Git Bash
   * ou `cmd`, nunca pelo nosso PowerShell — então nada de aspas simples (o
   * `cmd` não as conhece). Aspas DUPLAS com barras normais valem nos dois, e
   * caminho do Windows não pode conter `"`.
   */
  function hookCommand(node, script) {
    if (!isWin) return `${quote(node)} ${quote(script)}`;
    const fwd = s => String(s).replace(/\\/g, '/');
    return `"${fwd(node)}" "${fwd(script)}"`;
  }

  /**
   * Hooks do Claude por ARQUIVO (`--settings <arquivo>`) em vez de JSON inline.
   * O JSON é todo aspas duplas: inline ele dependeria de cada camada
   * (PowerShell, shim do npm) escapá-las direito. No macOS segue inline — é o
   * comportamento medido há meses.
   */
  const hookSettingsViaFile = isWin;

  // ── Onde o Claude guarda credencial e histórico ─────────────────────────────
  //
  // macOS: o OAuth do `claude` mora no Keychain do usuário do sistema; os
  // perfis sem token rodam com o HOME real e compartilham ~/.claude.
  // Windows: não há Keychain. O `claude` grava <USERPROFILE>\.claude\
  // .credentials.json, e cada perfil tem o seu USERPROFILE — logo cada perfil
  // tem a SUA conta, credencial e histórico em <perfil>\.claude.
  const claudeCredStore = isMac ? 'keychain' : 'profile-file';

  /** ~/.claude que o `claude` deste perfil usa (histórico, settings). */
  function claudeConfigDir(accountDir, envObj) {
    if (envObj && envObj.CLAUDE_CONFIG_DIR) return envObj.CLAUDE_CONFIG_DIR;
    if (claudeCredStore === 'profile-file' && accountDir) return p.join(accountDir, '.claude');
    return p.join(home, '.claude');
  }

  /** Arquivo de credencial do Claude (fallback do Keychain no Mac; a fonte no Windows). */
  function claudeCredFile(accountDir) {
    return p.join(claudeConfigDir(accountDir), '.credentials.json');
  }

  // ── Comparação de caminhos ──────────────────────────────────────────────────
  //
  // NTFS não diferencia maiúsculas (`C:\Dev\App` = `c:\dev\app`) e aceita as
  // duas barras. Comparar caminhos do Windows como string crua faz o mesmo
  // projeto parecer dois.

  /** Chave de comparação de um caminho (sem barra final; minúsculo no Windows). */
  function pathKey(x) {
    const s = String(x == null ? '' : x);
    return isWin ? s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : s.replace(/\/+$/, '');
  }

  /** `child` é `parent` ou está dentro dele. */
  function isSameOrInside(child, parent) {
    const c = pathKey(child), r = pathKey(parent);
    return c === r || c.startsWith(r + (isWin ? '\\' : '/'));
  }

  /** Último componente de um caminho, aceitando `/` e `\` no Windows. */
  function baseName(x) {
    const s = String(x == null ? '' : x).replace(isWin ? /[\\/]+$/ : /\/+$/, '');
    const parts = s.split(isWin ? /[\\/]/ : '/');
    return parts[parts.length - 1] || '';
  }

  // ── Recursos que só existem no macOS ────────────────────────────────────────
  /** Mini/pet: helper nativo Swift (helpers/norya-pet). */
  const supportsPet = isMac;

  // ── Vidro da janela (2026-09-07, liquid glass) ──────────────────────────────
  // macOS: NSVisualEffectView (`vibrancy` do BrowserWindow) — o wallpaper
  // aparece desfocado atrás da janela inteira. Windows 11 (build ≥ 22000):
  // Mica (`backgroundMaterial`). Fora disso a janela é opaca e o renderer
  // usa os tokens opacos (sem `html[data-glass]`). O renderer lê ESTE campo
  // no <head> de test-window.html; main.js lê no `new BrowserWindow`.
  const release  = String(opts.release || os.release());
  const winBuild = isWin ? Number(release.split('.')[2] || 0) : 0;
  const glass    = isMac ? 'vibrancy' : (isWin && winBuild >= 22000 ? 'mica' : null);

  return {
    platform, isWin, isMac, isPosix: !isWin, glass,
    path: p, pathSep, home,
    shellBin, shellArgs, shellArgsNonInteractive,
    quote, quoteStyle, joinCmds,
    agentPathDirs, agentShellPrelude, prependPath,
    ipcEndpoint, isPipe, restrict, unlinkEndpoint, userTag, uidTag,
    profileHomeEnv,
    openShimDirName, openShimBinName, authOpenBinName,
    probeCommand, probePrelude, execPrefix, scratchCwd,
    spawnOpts, windowless, detachGroup, killTree, killTreeCommand,
    which, runnable, chatLaunch,
    nodeBinName, hookCommand, hookSettingsViaFile,
    claudeCredStore, claudeConfigDir, claudeCredFile,
    pathKey, isSameOrInside, baseName,
    supportsPet,
  };
}

module.exports = makePlatform();
module.exports.makePlatform = makePlatform;
module.exports.quotePosix = quotePosix;
module.exports.quotePwsh = quotePwsh;
module.exports.quoteWinArg = quoteWinArg;
module.exports.escapeWinNativeArg = escapeWinNativeArg;
module.exports.PS_NATIVE_LEGACY = PS_NATIVE_LEGACY;
