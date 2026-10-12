# Terminal e seletores da TUI

Correções de 2026-09-16, reproduzidas no app instalado e cobertas por testes.

- **Geometria desde o spawn**: o primeiro fit pode ocorrer durante o `await` da
  biblioteca de skills. O main guarda os resizes desse intervalo e cria o PTY
  com a última geometria. Antes, o pane mostrava 111×28, mas `stty size` retornava
  120×35; linhas quebravam onde o CLI não esperava e cada redraw duplicava rodapés.
- **Um terminal por pane**: saída do grid não cria mais uma instância single-view
  oculta. Listeners de dados são removidos no exit, inclusive ao retomar o mesmo id.
- **Resize validado e ordenado**: `proposeDimensions()` vem antes de qualquer
  mudança; tamanhos transitórios abaixo de 20×5 não alteram xterm nem PTY.
  `createStream` serializa writes assíncronos e mudanças de geometria.
- **Replay com histórico de tamanhos**: `termHistory` retém trechos de saída e
  cada mudança de cols/rows, com teto de 256 Ki caracteres por spawn. Não basta
  reproduzir toda a saída no tamanho mais recente. É histórico limitado, não um
  transcript completo; o corte antigo de escapes continua conservador.
- **Seletores**: a guarda reconhece cursor-up mesmo partido entre pacotes do
  PTY e também arma com Tab, Shift+Tab, espaço e números. O nudge de resize só
  ocorre após o parse da saída, sincroniza xterm/PTY e é cancelado se o layout
  mudar ou o pane for destruído. Retry de fit de pane oculto é limitado.
- **Cancelamento do spawn**: fechar durante a preparação impede que o processo
  apareça depois. Exit atrasado do processo anterior não encerra o substituto.
- **Claude**: a biblioteca portátil bloqueia apenas a ferramenta `Skill`, não
  todos os comandos `/`. `/model`, `/config`, `/usage` e `/rc` continuam disponíveis;
  aliases de modelo como `opus[1m]` são aceitos. O catálogo segue orientando a
  ativação das skills; não é uma barreira de acesso aos arquivos locais.

## Verificação

- `test/terminal-stream.test.js`: largura mista com controle negativo, ordenação,
  descarte, limite de memória, escape fragmentado, tamanho inválido, corrida entre
  nudge/layout e limite dos retries.
- `test/smoke-tui.js`: Electron isolado + PTY real, preparo atrasado, geometria de
  nascimento, instância única, pergunta alta com redraw fragmentado, replay,
  remoção de listeners e cancelamento durante a preparação. Shell local, sem LLM.
- `test/smoke-claude-tui.js`: Claude instalado real; `/model` e `/config`, setas e
  resizes 51×14 → 110×30 → 51×16. Nenhum prompt ou chamada de modelo.
- Regressões existentes: `xterm-replay`, `tui-redraw`, `smoke-grid-ux` e suíte unitária.
