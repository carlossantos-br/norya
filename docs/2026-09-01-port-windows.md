# Port do Norya para Windows

Data: 2026-09-01 · Branch: `feat/windows-port`

## Resumo

O Norya nasceu 100% macOS: PTY em `zsh -l -c`, prelúdio de PATH com `nvm.sh` +
`brew shellenv`, três sockets Unix em `/tmp`, shim de `open` em `/bin/sh`,
Keychain, `launchctl`, `app.dock`. O port não é "trocar `/` por `\`": é isolar
cada uma dessas decisões atrás de UMA camada (`platform.js`) e dar a
implementação Windows de cada uma.

**A boa notícia que decide a viabilidade:** `node-pty@1.1.0` usa
**node-addon-api (N-API)** e **já traz prebuilds win32-x64 e win32-arm64 dentro
do pacote npm** (`node_modules/node-pty/prebuilds/`). Não há nada para compilar,
e ABI estável significa que o binário feito para Node funciona no Electron.
Por isso dá para gerar o instalador Windows a partir do Mac.

## Camada única: `platform.js`

| Conceito | macOS | Windows |
|---|---|---|
| shell do PTY | `$SHELL` ou `/bin/zsh`, `-l -c` | `pwsh.exe` se existir, senão `powershell.exe`, `-NoLogo -NoProfile -ExecutionPolicy Bypass -Command` |
| PATH das CLIs | prelúdio de shell (`nvm.sh`, `brew shellenv`) | montado em Node e injetado no `env` (nvm-windows, npm global, fnm, volta, winget links) |
| aspas do comando | POSIX `'...'` com `'\''` | PowerShell `'...'` com `''` |
| separador de PATH | `:` | `;` |
| IPC local | socket Unix em `/tmp` / `os.tmpdir()` | named pipe `\\.\pipe\norya-*` |
| permissão do IPC | `chmod 0600` | ACL implícita do named pipe (mesma sessão/usuário) |
| isolamento de perfil | `HOME=account.dir` | `USERPROFILE` + `HOME` + `HOMEDRIVE`/`HOMEPATH` = `account.dir` |
| interceptar `open <url>` | `bin/open-shim/open` (sh) | `bin/open-shim-win/{open,xdg-open,norya-open}.cmd` + `$BROWSER` |
| ferramentas nativas | launchd + `.app` (fala, captura) | não suportado — desligado com motivo explícito na UI |
| badge de atenção | `app.dock.setBadge` | overlay icon na taskbar |
| janela | `titleBarStyle: 'hiddenInset'` | `titleBarOverlay` |

## Ordem de execução

1. `platform.js` + testes unitários (posix e win32 forçados por injeção).
2. `agents/commands.js`: aspas por estilo, sem mexer no golden POSIX.
3. `main.js`: shell, prelúdio, PATH, sockets, env de perfil, janela, dock.
4. `browser/mcp-server.js` e `browser/auth-flow-router.js`: named pipes.
5. `bin/`: shims `.cmd` (`open`, `xdg-open`, `norya-browser`, `norya-auth-open`).
6. `helpers/native-tools.js`: `getuid` só em POSIX; status "indisponível".
7. `quota/*`: prelúdio vem do contexto, não cravado.
8. Renderer: glifos `⌘/⌥/⌃` viram `Ctrl/Alt` no Windows.
9. Empacotamento: `electron-builder` → NSIS x64, gerado no Mac.

## O que NÃO vai no port (e por quê)

- **Fala e captura nativas** (`NoryaSpeech`, `NoryaShot`): são `.app` + agentes
  launchd + APIs de permissão do macOS. Reescrever é um projeto próprio.
  No Windows a aba aparece desabilitada dizendo isso.
- **Assinatura de código**: não há certificado Windows. O instalador vai
  disparar o SmartScreen na primeira execução ("Mais informações" → "Executar
  assim mesmo"). Isso é esperado, não é defeito do build.
- **Migração de `~/.codex-panel`**: não existe no Windows. Instalação nova
  nasce em `%USERPROFILE%\.norya`.
