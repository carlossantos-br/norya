# Testes do Norya

## Smokes de caracterização

Existem para provar que uma remoção ou extração **não mudou o comportamento
observável**. Rode antes E depois de cada mudança. Todos exigem que o Norya
esteja fechado — duas instâncias disputam os arquivos de estado em `~/.norya/`.

```bash
node test/smoke-cdp.js          # renderer: estado, IPC, DOM, CSS, rail
node test/smoke-pty.js          # terminal: spawn real, bytes, kill
node test/smoke-browser.js      # navegador: painel abre, página real carrega
node test/smoke-multi-codex.js  # dois panes de Codex no mesmo perfil
node test/smoke-auto-open.js    # `open <url>` numa CLI abre aba no Norya
node test/smoke-agent-dispatch.js  # agentId escolhe a CLI; grok e opencode sobem
node test/smoke-thread-agent.js    # thread fixada não troca de CLI ao reabrir
node test/smoke-multi-account.js   # perfil grok isola credencial; token do claude
node test/smoke-mcp-browser.js     # automação do navegador por agente (MCP → <webview>)
node test/smoke-attention.js       # fila de atenção: som/banner só em fim de turno (claude/codex: só por evento)
node test/smoke-agent-events-claude.js  # E2E: claude REAL no PTY → hook → socket → agent-event (1 prompt curto, isolado)
node test/smoke-browser-resize.js  # arrastar a borda do dock (mouse REAL, via CDP)
node test/smoke-uso.js             # painel Uso: seção por conta, cartão por provider (isolado, roda com o app aberto)
node test/smoke-tasks-ux.js        # lista de Tasks: dono ≠ estado, "retomar aqui", × encerra
node test/smoke-adopt-thread.js    # adotar uma task de Codex em outra conta (roda o codex de verdade)
node test/smoke-threads-cache.js    # cache do list-threads (rollout + sqlite): hit provado, invalidação em editar/novo/apagar/renomear/perfil novo (isolado)
```

**`dispatchEvent(new MouseEvent(...))` não prova arrasto.** Ele entrega o evento
direto no alvo e pula o hit-test do Chromium — então passa mesmo quando arrastar
de verdade está quebrado, que foi exatamente o que aconteceu com a alça do dock
(a `<webview>` comia mousemove e mouseup e ninguém viu). Para input que depende
de QUEM recebe o evento, use `Input.dispatchMouseEvent` do CDP: `client.send` já
está exposto pelo arnês (`smoke-browser-resize.js` é o modelo).

## Unitários próprios (sem Electron, rápidos)

```bash
node test/agent-commands.test.js   # agents/commands.js: golden das 5 CLIs + shellQuote
node test/grok-parser.test.js      # quota/grok-parser.js: null quando não reconhece
node test/pty-parser-claude.test.js # quota/pty-parser.js: /usage real do Claude 2.1.263 (texto colado)
node test/claude-http.test.js      # quota/claude-http.js: endpoint do /usage, fixture real, token nunca em log
node test/codex-http.test.js       # quota/codex-http.js: plano, e-mail, resets grátis (app-server falso)
node test/quota-manager.test.js    # quota/index.js: chave "num:provider" + espelho legado, breaker por chave
node test/open-shim.test.js        # bin/open-shim/open: socket, auth, passthrough, fallback
node test/dev-url.test.js          # browser/dev-url.js: ANSI, dedupe, hosts disfarçados
node test/no-dangling-refs.test.js # nada referencia arquivo deletado na Fase 1
node test/norya-home.test.js       # resolução do diretório de dados (~/.norya)
node test/deploy-allowlist.test.js # todo require do main.js está no deploy.sh
node test/claude-event-hook.test.js  # helpers/norya-claude-event.js: background pendente no transcript, hook → evento, exit 0 sempre
node test/claude-turn-gate.test.js   # agents/agent-events.js: turn-end segurado 1,5 s, cancelado por PreToolUse/UserPromptSubmit
node test/codex-turn-events.test.js  # rollout do Codex → turn-start/turn-end/needs-you; qual rollout é de qual pane
```

## Port Windows — provados A PARTIR DO MAC

O app não roda aqui em Windows, mas quase tudo que o port muda é string:
comando, argv, PATH, caminho de socket. Esses testes constroem a camada de
plataforma com `makePlatform({ platform: 'win32' })` e conferem o resultado —
e, no mesmo arquivo, congelam a saída do macOS para o port não mexer nela sem
alguém perceber.

```bash
node test/platform.test.js            # platform.js nas duas plataformas + paridade macOS
node test/agent-commands-win.test.js  # golden das 5 CLIs com aspas de PowerShell
node test/win-spawn-shape.test.js     # linha de spawn, argv do node-pty, env do PTY
node test/badge-icon.test.js          # PNG do overlay da taskbar (o Dock badge do Windows)
node build/verify-win-package.js      # audita dist/win-unpacked: requires, assets, Mach-O
```

**`test/open-shim.test.js` falha se você rodar de dentro de um pane do Norya.**
O pane exporta `NORYA_OPEN_SOCKET`, e dois casos do teste dependem de NÃO haver
socket no ambiente. Rode com `env -u NORYA_OPEN_SOCKET -u NORYA_AUTH_SOCKET node
test/open-shim.test.js`.

| Arnês | O que prova | Custo |
|---|---|---|
| `smoke-cdp` | `st` e `api` globais, sidebar/composer no DOM, folha de estilo carregada e aplicada, zero exceção | ~10 s |
| `smoke-pty` | spawn de PTY num perfil chatgpt autenticado, bytes chegando por `terminal-data-<id>`, `kill-terminal` encerrando | ~25 s, **zero token** (só sobe a TUI) |
| `smoke-browser` | `prepareSession` devolve partition, `example.com` carrega, e os campos mortos (`preloadPath`, `torOk`, `socksPort`) não voltaram | ~30 s, exige rede |
| `smoke-multi-codex` | um perfil chatgpt sustenta **2** PTYs simultâneos: ambos falam, nenhum mata o outro, `auth.json`/`config.toml` intactos | ~35 s, **zero token** |

### Armadilhas de medição que já morderam

**`execFileSync` bloqueia o event loop.** Se o teste sobe um servidor (socket, HTTP)
e chama o binário sob teste de forma síncrona, o servidor não responde durante a
chamada. O binário estoura o timeout e cai no fallback, e o teste acusa um bug que
é dele. Use `execFile` assíncrono.

**`readFileSync(p, 'utf8').slice(byteOffset)`** desliza a cada caractere não-ASCII:
`statSync().size` conta bytes, `slice` conta unidades UTF-16. O `panel.log` tem `→` e
acentos. Fatie o **Buffer** e só então decodifique.

### Uma armadilha de PTY que já mordeu duas vezes

Ao medir PTYs por IPC, **anexe o listener antes de spawnar** (o canal
`terminal-data-<spawnId>` é determinístico quando você passa `spawnId`) e
**congele o veredito antes de matar** — o canal `terminal-exit-<id>` também
dispara no seu próprio `kill`, então ler a flag depois acusa um assassinato que
foi você quem cometeu. Sem `spawnId`, o id do PTY cai em `String(account.num)` e
o segundo spawn mata o primeiro (`main.js`, comentário ARCH FIX em
`spawnTerminal`) — um teste ingênuo mede isso e conclui a coisa errada.

Exceção não capturada reprova. `console.error` é reportado como aviso — o app
emite alguns em condição normal, e tratá-los como falha tornaria o arnês inútil.

`smoke-pty` pula sozinho se não houver perfil com `access_token`.
`smoke-browser` pula sozinho se não houver DNS.

### Infraestrutura

`test/cdp-harness.js` sobe o app, anexa via Chrome DevTools Protocol e entrega
`evaluate()`. Ele **não** usa `node_modules/.bin/electron`: aquilo é um wrapper
Node que spawna o binário real como filho, e matar o wrapper deixava o Electron
órfão segurando a porta 9222 (no macOS ele nunca sai sozinho — `main.js` só chama
`app.quit()` fora do darwin). O arnês resolve o binário real por
`require('electron')`, spawna `detached` e mata o **grupo** de processos.

Tem preflight: recusa rodar se já houver Electron deste app vivo ou se a porta
estiver ocupada. Porta configurável por `NORYA_SMOKE_PORT` (padrão 9222).

## Unitários

```bash
node quota/test/<arquivo>.test.js
node browser/test/<arquivo>.test.js
```

Scripts node com `assert`, saindo 0/1. Sem framework, sem dependências novas
(ver `quota/CONTRACT.md`).

## Instância isolada (rodar com o Norya de produção ABERTO)

`test/smoke-grid-ux.js` (fix-wave do grid, 2026-07-21) sobe uma instância
100% isolada: `NORYA_HOME` temporário, `NORYA_USER_DATA` próprio (lock de
instância única separado) e `NORYA_SOCKET_SUFFIX=-smoke` (não rouba o socket
`norya-open` do app vivo). Porta padrão 9223. Cobre: fechar o último pane,
template do grid pela fonte única (`computeVisibleGridIds`), render
incremental (célula DOM sobrevive a re-render) e o re-key do latch
(spawnId→threadId in place, com foco).

`test/claude-status-prelude.test.js` (unitário puro): o probe de quota do
Claude usa o `shellPrelude` canônico injetado (fix do exit 127 — `claude`
mora em `~/.local/bin`, fora do PATH mínimo do Finder/launchd).

`test/smoke-sidebar.js` (sidebar "Sessões abertas", 2026-10-10) — mesma receita
de isolamento do smoke-grid-ux, porta padrão 9224. Cobre: aviso com grid vazio,
só a seção "Sessões abertas" com os panes do grid na ordem do grid, sem busca,
rail "Sessões" e pane fechado saindo da lista.

`test/claude-meta.test.js` (unitário puro): scanner de rollouts do Claude
(claude-meta.js) — wrappers de comando local (caveat/stdout) não viram título,
content em array (imagem+texto) é parseado, precedência ai-title > firstMsg >
lastPrompt, filtros sdk/sidechain preservados.

`test/smoke-tasks-ux.js` (coerência da lista de Tasks, 2026-09-09) — mesma
receita de isolamento, porta 9227. Cobre as três separações da leva: o dono da
task virou chip de TEXTO na linha 2 (com a cor da conta) e o dot da direita
carrega SÓ o estado, com legenda por estado no tooltip; o botão "retomar aqui"
aparece quando dono ≠ perfil ativo e migra de linha quando o perfil ativo muda;
e o × do pane ENCERRA a task (⌥+clique só esconde). O caso do dot tem controle
negativo: reintroduzir `dot.style.background` no `updateWorkingIndicators` faz o
smoke falhar — foi verificado, não é tautologia.

`test/smoke-adopt-thread.js` (adoção entre contas, 2026-09-09) — porta 9228.
Roda o `codex` REAL: fabrica dois perfis num NORYA_HOME temporário, deixa um
rollout só no perfil 1 e exige que, depois do IPC `thread-adopt-profile`, a
thread exista na `state_5.sqlite` do perfil 2 — que é o que faz
`codex resume <id>` funcionar lá. Foi este smoke que descobriu que copiar o
rollout NÃO basta: num perfil que já tem thread-store o `migrate-rollouts`
devolve `failure_reason: "missing_sqlite_metadata"`, e a linha de `threads`
precisa ir junto. Custo zero de token (o migrate é local). Cobre também a
idempotência (2ª adoção volta `already_paginated`) e a recusa de providers sem
caminho de adoção.

Gotcha ambiental: `open-shim.test.js` caso 4 ("sem socket nenhum") FALHA se o
Norya de produção estiver aberto — o socket real `<tmp>/norya-<uid>/norya-open-<uid>.sock`
existe e o shim roteia pra ele em vez de cair no `open` do sistema. Rodar esse
teste com o app fechado.

## Eventos de turno (som de fim de turno, 2026-10-04)

Para Claude e Codex o som de "pane terminou" não vem mais da heurística de bytes
do PTY. Claude: hooks passados por `claude --settings` (somam aos do usuário)
chamam `helpers/norya-claude-event.js`, que escreve no socket
`norya-events-<uid><NORYA_SOCKET_SUFFIX>.sock`; o main segura o turn-end 1,5 s
(Stop hook do usuário pode bloquear e o Claude seguir). Codex: o main acompanha
o rollout `.jsonl` do pane (`agents/codex-turn-watch.js`). Tudo chega ao
renderer pelo IPC `agent-event`.

`smoke-agent-events-claude.js` roda o `claude` de verdade num perfil isolado sem
token (Keychain + `~/.claude` real, então os hooks do usuário rodam junto). A
pasta precisa ser JÁ confiada pelo Claude — o padrão é o HOME; troque com
`NORYA_SMOKE_CLAUDE_CWD`. O teste recusa aceitar o diálogo de confiança, porque
aceitar gravaria no `~/.claude.json` do usuário. Sons: `node assets/sounds/generate.js`.
