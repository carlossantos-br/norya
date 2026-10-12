# Atualizações dos providers

O botão ao lado de Settings consulta a instalação do usuário do sistema, usando o
mesmo prelúdio/PATH da detecção, TUI e sondas de quota. Contas isolam credenciais;
não são instalações independentes das ferramentas. A versão exibida é a que um
novo processo executará, não a versão de uma sessão que já estava aberta.

- Consulta após o boot (15 s) e ao ganhar foco, com cache em memória de
  15 minutos (1 minuto após falha). Abrir a janela ou Buscar atualizações sempre
  força consulta; estados antigos deixam de dizer atualizado durante a busca. Não instala automaticamente.
- npm (Codex, Claude, OpenCode): identifica o pacote pelo destino real do launcher,
  consulta `registry.npmjs.org` e executa Node + npm-cli.js daquele mesmo prefixo,
  `--global --prefix <prefixo>`, versão exata e configuração npm vazia. Não usa o
  `npm` encontrado casualmente no PATH. Instalação desconhecida/prerelease é manual.
- Claude nativo: consulta `downloads.claude.ai/claude-code-releases/<canal>`;
  respeita `autoUpdatesChannel` global (também no npm); instala com `claude install <versão>`.
- Grok nativo: `update --check --json` valida canal e instalador; aplica com
  `update --version <versão>`. Não troca stable/alpha silenciosamente.
- Homebrew: consulta a API oficial para fórmulas core e a fórmula remota para
  `anomalyco/tap/opencode`; copia `brew update && brew upgrade <fórmula>` para
  executar no Terminal do computador. Não aplica updates de dependências pelo app.
- Windows e outros instaladores: não há aplicação integrada validada. A UI mostra
  instrução manual/erro de consulta; não oferece botão de instalar sem adapter.

A UI distingue versão instalada, versão disponível no canal e versão acima do
canal, sem sugerir downgrade. Sessões abertas mantêm a versão com que iniciaram.

Uma fila por provider, um instalador por vez. Inclui panes ocultos e de login na
contagem. A trava começa antes dos awaits, impede novos panes daquele provider,
pausa sondas e aguarda as já existentes. Checagem de processos externos por `ps`
é conservadora (não mata processos). Fila é cancelável também durante a preparação assíncrona, acompanha sessões a cada
5 s somente enquanto houver jobs e é descartada ao sair do app. A checagem externa
não constitui um mutex com gerenciadores ou programas externos: não atualize a
mesma ferramenta simultaneamente pelo Terminal.

Antes de aplicar, revalida launcher, destino e versão. Há lock de disco com PID do
app/instalador e registro `provider-update-job.json` no NORYA_HOME; job interrompido
vira diagnóstico, não reinstalação automática. Não há rollback garantido. Se o
instalador falhar, consulte novamente e use o instalador original para reparar uma
instalação que não inicializa. Não há fechamento automático de panes.

O instalador recebe HOME real e ambiente permitido explicitamente, sem chaves de
provider, NODE_OPTIONS, CODEX_HOME, CLAUDE_CONFIG_DIR, npm prefix de perfil ou cwd
de projeto. Saída e duração são limitadas; processos POSIX rodam em grupo próprio,
encerrado no timeout. UI/IPC só passam id conhecido, nunca um comando ou versão.

Após instalar, valida a versão pelo launcher que será usado no próximo spawn e
`--help`. Codex também precisa responder a `initialize` de `app-server`, com
CODEX_HOME temporário sem credenciais; nenhuma chamada de modelo/pagamento. O aviso
interno do Codex é desativado apenas nos panes (`check_for_update_on_startup=false`)
e o auto-updater do Claude apenas nos processos gerenciados (`DISABLE_AUTOUPDATER`).
O atualizador não executa `deploy.sh` nem reinicia o Norya.

## Validação

- `node test/provider-updates.test.js`: 27 casos de fila, corrida com sessões,
  probes, exclusão de credenciais, canal/versão, offline, timeout, erro de
  instalador, versão incorreta, falha de protocolo, lock e interrupção.
- `node test/smoke-provider-updates.js`: Electron isolado, IPC real + UI com estados
  controlados (botão/contador, agendamento/cancelamento, fechamento, erro e retry).
- `node test/smoke-provider-update-install.js`: integração opcional com rede;
  instala a versão atual do Codex numa pasta temporária e atualiza para latest,
  incluindo handshake. Não altera a instalação de uso diário. Rodada 2026-09-11:
  0.153.4 → 0.154.0 passou; instalação real permaneceu 0.153.4.
- Suíte geral: `env -u NORYA_OPEN_SOCKET -u NORYA_AUTH_SOCKET npm run test:unit`.
  Os sockets herdados de panes interferem no teste legado de fallback do open shim.

Deploy: `bash deploy.sh --no-restart` instala e assina o bundle preservando panes;
requer sair por completo (⌘Q) e abrir novamente para ativar o novo main/renderer.
Sem a opção, o script mantém o comportamento histórico de encerrar/reabrir.

## Fontes dos contratos

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [Configuração Codex](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Instalador oficial Claude](https://claude.ai/install.sh)
- `codex update --help`, `claude install --help`, `grok update --help` e
  `grok update --check --json` dos executáveis locais.
- [API Homebrew](https://formulae.brew.sh/api/formula/aider.json)
- [Fórmula OpenCode](https://raw.githubusercontent.com/anomalyco/homebrew-tap/HEAD/opencode.rb)
