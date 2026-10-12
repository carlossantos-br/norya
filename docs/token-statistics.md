# Estatísticas de tokens locais

O painel Estatísticas lê contadores registrados pelos agentes, sem usar percentual
restante da assinatura ou estimativas pelo tamanho do texto. Fonte de verdade:
`token-stats.js`; IPC `get-token-stats`; apresentação em `renderer/settings.js`.

- **Codex:** todos os JSONL de `sessions` e `archived_sessions`, no HOME do app e
  em cada `accounts/N/.codex`. `token_usage_record.usage` por `response_id` é
  preferido; `event_msg.token_count` legado vira deltas do contador acumulado.
  Os contadores de contexto e do ledger de respostas têm baselines independentes:
  a compactação pode mudar apenas o primeiro. As duas representações da mesma
  resposta são reconciliadas, inclusive quando existem em cópias diferentes.
- **Claude:** todos os JSONL de `.claude/projects`, globais e isolados, incluindo
  subdiretórios de subagentes. Deduplicação por message ID + request ID, conservando
  o maior snapshot de usage da resposta transmitida. Em um formato observado, o
  agregado externo é zerado mas `iterations` preserva os contadores; somente nesse
  caso recuperamos a soma das iterações.
- **OpenCode:** SQLite local, mensagens assistant com `tokens`, `providerID` e
  `modelID`. O schema separa reasoning de output: os dois formam a saída normalizada.
- **Grok e Aider:** indisponibilidade explícita. Nenhum contador é inventado a
  partir de quotas ou de números arredondados da TUI.

## Aritmética e cobertura

Entrada normalizada inclui cache lido e gravado; saída normalizada inclui
raciocínio. Total detalhado = entrada + saída. No Claude a entrada original é
somente a parcela não cacheada: somamos cache read e cache creation. Contadores
inválidos, negativos ou não inteiros são rejeitados e sinalizados na cobertura.

Uma resposta é contada uma vez mesmo quando seu histórico foi copiado/retomado
em outro perfil ou herdado por um fork. A localização do arquivo identifica o
perfil de armazenamento; ela não comprova a assinatura que pagou a resposta.
Cópias entre perfis ficam em Global / compartilhado. Claude global nunca é
atribuído ao perfil atualmente selecionado.

Datas são do evento de consumo. Baselines sem data e threads existentes somente
no SQLite são incluídos em Todo o histórico e excluídos de filtros de período.
Threads arquivadas entram; não há LIMIT 500. Totais SQL nunca são somados sobre
sessões já medidas. Não existe precisão verificável para históricos apagados sem
contadores preservados, chats web ou outros dispositivos.

## Custo equivalente de API (2026-10-04)

`pricing.js` responde "quanto esse uso custaria pago pela API", aplicado a cada
resposta no worker (`row.cost`). Não é fatura: assinaturas não cobram por token.
Preços públicos de tabela (Anthropic e OpenAI, `VERIFIED_AT` + `SOURCES` no
módulo), tier padrão, sem batch nem desconto negociado.

- Claude: entrada não cacheada; cache lido pelo preço de hit do modelo (0,1× na
  maioria, 0,05× Opus 5.5, 0,025× Fable/Mythos 5.1); escrita de cache separada
  em 5 min (1,25×) e 1 h (2×) a partir de `usage.cache_creation`; saída (com
  raciocínio); `speed: "fast"` usa a tabela fast nos Opus que a têm; buscas web
  a US$ 10/1.000. Sem sobretaxa de contexto longo desde a família 4.6.
- Codex/OpenAI: entrada, cache lido, cache gravado e saída; requisição com
  entrada acima de 272K usa a tabela de contexto longo inteira; Fast mode
  (`thread_settings_applied.service_tier = "priority"`) usa a tabela Fast.
- Modelo sem preço público (ex.: `codex-auto-review`) e histórico só com total
  ficam SEM custo e a UI informa quantos tokens ficaram de fora. Nunca há preço
  "parecido" — foi o erro da estimativa antiga, removida em 2026-09-10.
- Câmbio: PTAX de venda do BCB (`fx.js`, cache 12 h em `fx-usd-brl.json`); sem
  rede, a última cotação conhecida, marcada.

Arquivos que deixam de existir (perfil apagado, limpeza do CLI) têm os eventos
preservados no índice (`gone: true`) e continuam contando, marcados
`preserved`; conteúdo só movido (arquivamento) não duplica porque as chaves de
evento coincidem. `node test/pricing.test.js` trava os preços conferidos.

## Execução e verificação

Worker thread lazily iniciado pelo IPC; streaming de JSONL, atualização incremental
por byte até a última linha completa, cache em `token-usage-index.json` (somente
metadados/contadores, sem prompts/respostas). Arquivos inalterados não são relidos
nem regravam o índice. O cache se invalida por versão/tamanho/mtime/inode.
Leitura SQLite somente leitura: builtin Node quando disponível, sqlite3 no Node 20.
Atualiza ao abrir a aba, pelo botão Atualizar e a cada 30 s enquanto estiver visível.
Falhas preservam a última leitura com aviso; fonte não lida não significa zero.

`node test/token-stats.test.js`: aritmética, streaming, compactação, aliases entre
cópias, arquivos parciais, UTF-8/CRLF, subagentes, DB-only, mais de 500 threads,
OpenCode, cache e concorrência do worker.
`node test/smoke-token-stats.js`: Electron isolado com IPC/worker real, tela,
filtros de provider e datas locais, números inteiros, refresh e falhas.

O deploy inclui `token-stats.js` na allowlist do macOS. Não copiar arquivos
parcialmente para o bundle assinado em execução; usar `deploy.sh` com restart.

## Fontes dos contratos

- [Claude: campos de cache e fórmula da entrada](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance)
- [OpenCode: normalização de usage](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts)
- [Codex: protocolo app-server](https://developers.openai.com/codex/app-server/)

Os formatos de rollout e suas variações também foram conferidos nos arquivos
locais instalados em 10/09/2026. Não são uma promessa de compatibilidade futura
com qualquer versão dos CLIs.
