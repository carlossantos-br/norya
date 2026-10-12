'use strict';

/**
 * quota/grok-usage.js — lê o uso da assinatura SuperGrok.
 *
 * O Grok Build NÃO tem subcomando de usage (verificado em grok 0.2.93): só o
 * slash command `/usage`, dentro da TUI. Então este fetcher faz o que o
 * ClaudeStatusFetcher faz: sobe um PTY escondido, digita `/usage`, captura,
 * parseia e mata. É caro (~10 s) — por isso roda SOB DEMANDA, no ↻.
 *
 * Diferente do Codex e do Claude, a quota do Grok é GLOBAL, não por perfil: o
 * `grok login` guarda credencial em `~/.grok`, por usuário do sistema, e não
 * dentro do diretório do perfil. Modelá-la como "mais um perfil" mentiria sobre
 * onde a credencial mora.
 *
 * Estados devolvidos, todos honestos:
 *   { state: 'logged-out' }          precisa de `grok login`
 *   { state: 'unknown', raw }        subiu, mas o `/usage` não foi reconhecido
 *   { state: 'ok', snapshot }        parseado
 *   { state: 'error', error }        não subiu
 *
 * Injeções: pty (node-pty), shellPrelude() (o mesmo PATH do spawn), logFn.
 */

const { execFile } = require('child_process');
const { parseGrokUsage, detectGrokLoggedOut } = require('./grok-parser');

const ESPERA_TUI_MS = 3500;    // tempo até a TUI aceitar teclado
const QUIETO_MS = 1500;        // silêncio após conteúdo → assentou
const TIMEOUT_MS = 20000;
const AUTH_TIMEOUT_MS = 8000;

class GrokUsageFetcher {
  constructor({ pty, shellPrelude, shell, shellArgs, cwd, execPrefix, env, logFn } = {}) {
    if (!pty) throw new Error('GrokUsageFetcher: pty é obrigatório');
    this._pty = pty;
    this._prelude = shellPrelude || (() => '');
    this._shell = shell || process.env.SHELL || '/bin/zsh';
    // argv do shell e cwd descartável vêm de fora (platform.js). O default
    // POSIX mantém os testes que constroem o fetcher com o mínimo.
    this._shellArgs = shellArgs || (cmd => ['-l', '-c', cmd]);
    this._cwd = cwd || '/tmp';
    this._exec = execPrefix != null ? execPrefix : 'exec ';
    this._env = env || process.env;
    this._log = logFn || (() => {});
  }

  /**
   * Pergunta barata: `grok models` é NÃO-interativo, responde em milissegundos e
   * diz literalmente "You are not authenticated." quando não há sessão.
   *
   * A TUI não imprime isso (mostra uma tela de login). Checar autenticação
   * subindo um PTY de 20 s, tendo este comando de uma linha, é força bruta.
   *
   * @returns {Promise<boolean>} true = sem sessão.
   */
  _semSessao() {
    return new Promise(resolve => {
      const cmd = [this._prelude(), 'grok models'].filter(Boolean).join('; ');
      execFile(this._shell, this._shellArgs(cmd), { timeout: AUTH_TIMEOUT_MS, env: this._env, windowsHide: true },
        (_err, stdout, stderr) => resolve(detectGrokLoggedOut(String(stdout) + String(stderr))));
    });
  }

  /** @returns {Promise<{state, snapshot?, raw?, error?}>} — nunca lança. */
  async fetch({ timeoutMs = TIMEOUT_MS } = {}) {
    // Barato primeiro. Sem sessão, o `/usage` não teria o que responder.
    if (await this._semSessao()) {
      this._log('grok-usage', 'sem sessão — `grok login` necessário');
      return { state: 'logged-out' };
    }

    let proc = null;
    let buf = '';

    const matar = () => { try { proc && proc.kill(); } catch { /* já morto */ } };

    try {
      const initCmd = [this._prelude(), `${this._exec}grok`].filter(Boolean).join('; ');
      proc = this._pty.spawn(this._shell, this._shellArgs(initCmd), {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: this._cwd, env: this._env,
      });
    } catch (err) {
      return { state: 'error', error: `spawn falhou: ${err.message}` };
    }

    return await new Promise(resolve => {
      let terminado = false;
      let quieto = null;
      let mandouUsage = false;

      const terminar = (r) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(quieto);
        clearTimeout(duro);
        matar();
        resolve(r);
      };

      const duro = setTimeout(() => {
        this._log('grok-usage', `timeout de ${timeoutMs}ms`);
        terminar({ state: 'unknown', raw: buf.slice(-2000) });
      }, timeoutMs);

      proc.onData(d => {
        buf += d;

        // O CLI diz isto sem rodeios quando não há sessão. Não adianta esperar
        // o `/usage`: ele não vai responder nada útil.
        if (detectGrokLoggedOut(buf)) return terminar({ state: 'logged-out' });

        if (!mandouUsage) return;

        // Assentou: 1,5 s sem novos bytes depois do /usage.
        clearTimeout(quieto);
        quieto = setTimeout(() => {
          const snap = parseGrokUsage(buf);
          if (snap) {
            this._log('grok-usage', `parseado: ${snap.usedPercent}% semanal`);
            terminar({ state: 'ok', snapshot: snap });
          } else {
            // Não reconhecemos. NÃO inventamos número.
            this._log('grok-usage', 'saída não reconhecida — devolvendo unknown');
            terminar({ state: 'unknown', raw: buf.slice(-2000) });
          }
        }, QUIETO_MS);
      });

      proc.onExit(({ exitCode }) => {
        if (detectGrokLoggedOut(buf)) return terminar({ state: 'logged-out' });
        terminar({ state: 'error', error: `grok saiu com código ${exitCode}` });
      });

      // Dá tempo da TUI subir, então digita o slash command.
      setTimeout(() => {
        if (terminado) return;
        mandouUsage = true;
        try { proc.write('/usage\r'); } catch (err) {
          terminar({ state: 'error', error: `write falhou: ${err.message}` });
        }
      }, ESPERA_TUI_MS);
    });
  }
}

module.exports = GrokUsageFetcher;
