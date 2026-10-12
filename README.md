# Norya

**One desktop app for all your AI coding agents.** Norya runs Codex, Claude
Code, Grok, OpenCode and Aider side by side, across as many accounts as you
have, and shows how much of each subscription is left in real time.

[Português](README.pt-BR.md) · [MIT License](LICENSE)

## What it does

- **Profiles.** Each profile is an isolated account (its own home directory for
  the CLIs), with a name and a color. Open one session per profile, or several,
  and switch accounts without logging out.
- **Grid of sessions.** Agent sessions open as panes in a grid: real terminals
  (xterm.js + node-pty) or a chat view for Claude Code and Codex with
  attachments, a message queue, `/` commands, `@` file completion and context
  usage.
- **Live quota.** Session and weekly limits per profile and per provider (Codex
  through `codex app-server`, Claude through the same usage endpoint the CLI's
  `/usage` uses, Grok through its TUI), with reset times.
- **Attention queue.** A sound and a badge when an agent finishes or needs you,
  driven by the agents' own events (Claude hooks, Codex rollouts) instead of
  guessing from terminal output.
- **Built-in browser with automation.** An embedded browser that agents drive
  through an MCP server (`norya-browser`), so previews and browser tests stay
  inside the app. `open <url>` from any agent lands there too.
- **Workspaces.** Optional git worktree per thread, fork of a session into a new
  branch, and a merge queue.
- **Shared skills.** One skill library for every provider: Norya finds the
  `SKILL.md` files of all installed agents and lets you enable or disable each
  one for all of them at once.
- **Provider updates and token statistics.** Checks for new CLI versions and
  counts tokens from the agents' local logs, with the equivalent API cost.
- **Mini (macOS).** A small floating mascot that shows what the agents are doing
  while Norya is in the background.

The interface is in Brazilian Portuguese.

## ⚠️ Agents run with full access

Norya is built for a single developer on their own machine. **Sessions start
without approval prompts**: Claude Code gets `--dangerously-skip-permissions`,
and new Codex profiles are created with `approval_policy = "never"` and
`sandbox_mode = "danger-full-access"`. The chat view lets you pick a stricter
mode per session. Do not point Norya at code or folders you do not trust.

## Requirements

- **macOS** (developed and tested on Apple silicon) or **Windows** 10 (1809+) / 11 x64.
- **Node.js** LTS and **git**.
- The agent CLIs you want to use, installed separately (Norya does not install
  them): for example `npm install -g @anthropic-ai/claude-code @openai/codex`.

## Run from source

```sh
npm install
npm start
```

Data lives in `~/.norya` (`%USERPROFILE%\.norya` on Windows): profiles,
threads, quota cache and settings. Credentials stay exactly where each CLI
writes them: the profile's folder, or the macOS Keychain for Claude.

## Windows installer

```sh
npm run dist:win   # builds dist/Norya-Setup-<version>-x64.exe (built and checked on macOS)
```

The installer is per-user (no administrator) and unsigned, so SmartScreen will
warn on first run. See [docs/windows.md](docs/windows.md) for what differs from
macOS.

## Tests

```sh
npm run test:unit                 # pure unit tests, seconds, no Electron
node quota/test/index.test.js     # each quota/ and browser/ test also runs alone
```

`test/smoke-*.js` drive the real app over the Chrome DevTools Protocol; see
[test/README.md](test/README.md).

## Mini sprites

The Mini mascot uses the Clawd sprite from Claude.app and the Codex sprite from
ChatGPT.app. Those images belong to their owners and are **not** in this
repository. If you have the apps installed, `python3 tools/pet-assets.py`
extracts them into `assets/pet/` for your own local use; without them, the Mini
stays off.

## Not affiliated

Norya is an independent project. It is not affiliated with or endorsed by
Anthropic, OpenAI, xAI or any other provider. Claude, Codex, Grok and the other
names belong to their owners.

## License

[MIT](LICENSE)
