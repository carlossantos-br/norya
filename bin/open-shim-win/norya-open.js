'use strict';

/**
 * norya-open — shim de abertura de URL para Windows.
 *
 * Equivalente do `bin/open-shim/open` (sh) do macOS. O diretório que contém
 * este arquivo é prependado ao PATH de TODO PTY que o Norya spawna, e o
 * caminho do `.cmd` irmão vira o `$BROWSER`. Quando uma CLI manda abrir uma
 * página, a URL cai aqui e vai para a aba do navegador do Norya.
 *
 * Regras (as mesmas do shim do macOS):
 *   • Só http:// e https:// são interceptados.
 *   • O fluxo de login tem precedência: NORYA_AUTH_SOCKET vence NORYA_OPEN_SOCKET.
 *   • Falhou o envio? A URL abre no navegador do sistema. Uma URL NUNCA é
 *     engolida em silêncio — é a diferença entre "não abriu ainda" e "sumiu".
 *
 * Honestidade sobre cobertura: no macOS o shim pega quase tudo, porque as CLIs
 * chamam `open <url>`. No Windows não existe um `open` canônico — quem usa
 * `cmd /c start` passa longe daqui. Por isso a rede de segurança continua sendo
 * a leitura de URL do stdout do PTY (auth-flow-router + detectDevServer), que
 * funciona igual nas duas plataformas.
 */

const net = require('net');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//i.test(a));
const sock = process.env.NORYA_AUTH_SOCKET || process.env.NORYA_OPEN_SOCKET || '';

/** Navegador do sistema. `start` é builtin do cmd, daí o `cmd /c`. */
function sistema() {
  const alvo = url || args[0];
  if (!alvo) process.exit(0);
  try {
    // O primeiro "" é o TÍTULO da janela: sem ele o `start` trata uma URL
    // entre aspas como título e não abre nada.
    const p = spawn('cmd', ['/d', '/s', '/c', 'start', '""', alvo],
      { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    p.unref();
  } catch { process.exit(1); }
  process.exit(0);
}

if (!url || !sock) sistema();

const client = net.createConnection(sock, () => {
  // Sai quando a escrita é DESCARREGADA, não quando o servidor fecha: esperar o
  // outro lado tornaria o shim refém de um main ocupado, e o timeout abriria a
  // URL duas vezes (Norya + sistema).
  client.end(JSON.stringify({ url, ts: Date.now() }), () => process.exit(0));
});
client.on('error', () => sistema());
setTimeout(() => sistema(), 2000).unref();
