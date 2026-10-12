# Norya no Windows

Instalador: `dist/Norya-Setup-<versão>-x64.exe` (Windows 10 1809+ / 11, x64).
Gerado a partir do Mac com `npm run dist:win`.

## Instalar

1. Rode o `.exe`.
2. O **SmartScreen vai avisar** ("O Windows protegeu o computador"). Isso é
   esperado: não há certificado de assinatura de código. Clique em
   **Mais informações → Executar assim mesmo**.
3. Instalação **por usuário**, em `%LOCALAPPDATA%\Programs\Norya` — não pede
   administrador. Cria atalho na Área de Trabalho e no Menu Iniciar.

Os dados ficam em `%USERPROFILE%\.norya` (perfis, threads, quota, projetos) —
o desinstalador **não** apaga essa pasta.

## Antes de usar: o que o Norya não instala

O Norya é o painel; as CLIs de agente são programas separados. Sem elas o app
abre normalmente e mostra cada agente como "ausente" na aba Uso.

| Precisa de | Por quê |
|---|---|
| **Node.js LTS** | as CLIs (`claude`, `codex`, `opencode`) são pacotes npm; os shims do Norya também rodam em Node |
| **Git para Windows** | branches, worktrees e a Merge Queue |
| **PowerShell 7** (opcional) | o Norya usa o PowerShell 5.1 de fábrica se não achar o `pwsh`; o 7 tem UTF-8 por padrão e um ConPTY melhor comportado |

Instalação das CLIs (PowerShell):

```powershell
npm install -g @anthropic-ai/claude-code   # claude
npm install -g @openai/codex               # codex
```

O Norya procura executáveis em `%APPDATA%\npm`, `%USERPROFILE%\.local\bin`,
`%USERPROFILE%\.claude\local`, `%USERPROFILE%\.grok\bin`, `%USERPROFILE%\.bun\bin`,
`%USERPROFILE%\scoop\shims`, `%ProgramFiles%\nodejs`, `WindowsApps` e o `bin` do
Chocolatey — além do PATH que você já tem. Se instalou uma CLI em outro lugar,
basta ela estar no PATH do usuário.

## O que muda em relação ao Mac

| | macOS | Windows |
|---|---|---|
| Terminal | `zsh -l -c` | PowerShell (`pwsh` se existir, senão o 5.1) via ConPTY, com `$PSNativeCommandArgumentPassing='Legacy'` fixado (o 5.1 e o 7.x passam argumentos às CLIs do mesmo jeito) |
| Pane em modo chat | `zsh -l -c 'exec claude -p …'` | a CLI **direto, sem shell**: `claude.exe`, ou `node.exe <pacote>\cli.js` lido do shim do npm (`claude.cmd`/`.ps1`). Sem binário resolvível, cai no PowerShell com a console em UTF-8 |
| Fechar um pane de chat | `kill(-pid)` no grupo | `taskkill /PID <pid> /T /F` (leva junto os shells do Bash tool, MCPs e o `codex.exe`) |
| Atalhos | ⌘K, ⌘N, ⌘G… | **Ctrl+**K, Ctrl+N, Ctrl+G… (a lógica sempre aceitou os dois; agora os rótulos também) |
| Contador de panes aguardando | badge no Dock | ícone de sobreposição na barra de tarefas |
| Barra de título | integrada (`hiddenInset`) | barra nativa do Windows |
| Isolamento de conta | `HOME` por perfil | `USERPROFILE` por perfil |
| Várias contas de Claude | exige `claude setup-token` (o OAuth mora no Keychain) | **funciona sem token**: o `claude` grava a credencial em `<perfil>\.claude\.credentials.json`, e o perfil já tem o seu. A aba Uso lê a quota da credencial **do perfil**; o histórico, a sidebar e o histórico do chat leem `<perfil>\.claude\projects` |
| Adotar task de Claude em outra conta | só troca o dono (HOME real compartilhado) | **copia o transcript** para `<perfil destino>\.claude\projects\<mesma pasta>` |
| Som de fim de turno do Claude | hook `'<node>' '<helper>'` (ou o Electron em modo node) | hook `"C:/…/node.exe" "C:/…/norya-claude-event.js"` (aspas duplas, barras normais — vale no Git Bash e no `cmd`), passado por **arquivo** (`--settings %USERPROFILE%\.norya\claude-hook-settings.json`). Sem `node.exe`, sem hook: volta a heurística de bytes do PTY |
| Sockets locais | socket Unix por uid | named pipe `\\.\pipe\norya-<usuário>-…` (o namespace de pipes é da máquina) |
| Processos filhos (git, PowerShell) | — | sempre com `windowsHide` (sem janela preta piscando) |
| Captura de tela do navegador (MCP) | `/tmp/norya-shot-*.png` | `%TEMP%\norya-shot-*.png` |

## O que NÃO existe no Windows

- **Mini / mascote flutuante** (Ajustes → Aparência). É um helper nativo em
  Swift (`helpers/norya-pet`) com atalho global de macOS. No Windows a seção
  não aparece (`platform.supportsPet`).
- **Atualização integrada das CLIs** (Ajustes → Providers). A versão instalada
  aparece (lida do `cli.js` pelo `node.exe`, sem passar pelo shim), mas o botão
  fica em "Consulte as instruções do provider" — atualize com `npm install -g`.
- **Interceptação de `open <url>` com a mesma cobertura.** No macOS as CLIs
  chamam `open`, e o shim do Norya pega quase tudo. No Windows não existe um
  `open` canônico: quem usa `cmd /c start` passa longe do shim. A rede de
  segurança continua sendo a leitura de URL do stdout do PTY (é ela que sustenta
  o fluxo de login), e essa funciona igual nos dois sistemas.

## Onde o port mora, se precisar mexer

Toda diferença de plataforma está em **`platform.js`** — shell, argv, PATH,
aspas (PowerShell + escape de argumento nativo), sockets, isolamento de perfil,
sonda de CLI, spawn sem janela, kill da árvore, resolução de shim do npm, hook
e credencial do Claude, comparação de caminhos. Nenhum outro arquivo testa
`process.platform`; se um `=== 'win32'` aparecer fora dali, a próxima diferença
vai nascer espalhada de novo. Os módulos recebem a instância por injeção
(`platform:` em chat-session, updates, codex-turn-watch; `plat:` em
agents/claude-hook.js) — é assim que o teste prova o Windows do Mac.

O pacote copia por **allowlist** (`files:` do `electron-builder.win.yml`).
Arquivo novo na raiz tem que entrar lá — o `test/win-package-files.test.js`
falha se algum `require()` alcançável ficar de fora.

Testes que rodam no Mac e provam o comportamento do Windows:

```bash
node test/platform.test.js           # a camada inteira, nas duas plataformas
node test/platform-win.test.js       # helpers novos: aspas → argv, pipes, kill, shims do npm, hook, Claude
node test/agent-commands-win.test.js # golden das 5 CLIs + o argv que a CLI RECEBE pelo PowerShell
node test/win-spawn-shape.test.js    # a linha de spawn e o env do PTY
node test/win-parity.test.js         # chat-session, updates, rollout-adopt, codex-turn-watch, claude-hook
node test/win-package-files.test.js  # todo require() alcançável está no files: do yml
node test/badge-icon.test.js         # o PNG do badge da taskbar
node build/verify-win-package.js     # audita o dist/ (requires, assets, binários)
```

## Reconstruir o instalador

```bash
npm run dist:win        # gera build/icon.ico e o NSIS em dist/
node build/verify-win-package.js
```

Precisa de Node 20+ para o electron-builder (o `npm start` do dia a dia roda em
qualquer versão). Não precisa de Wine: o NSIS que o electron-builder baixa roda
nativo no macOS, e o node-pty **já vem com os binários de win32 prontos**
(`node_modules/node-pty/prebuilds/win32-x64`) porque usa N-API — é isso que
torna o build cruzado possível sem uma máquina Windows.
