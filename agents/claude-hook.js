'use strict';

/**
 * agents/claude-hook.js — a linha de comando do hook de eventos do Claude
 * (helpers/norya-claude-event.js), que avisa o Norya de início/fim de turno.
 *
 * Saiu do main.js (2026-10-12) para o comportamento das duas plataformas ser
 * testável a partir do Mac (test/claude-hook.test.js) — `plat` é um
 * `makePlatform(...)`, e o disco entra por `fsImpl`.
 *
 * Interpretador: um `node` de verdade sobe em ~50 ms; o Electron em modo node
 * (sempre presente) em ~100 ms — fica de reserva para quem não tem node.
 *
 *   macOS   → `'<node>' '<helper>'` ou `ELECTRON_RUN_AS_NODE=1 '<Norya>' '<helper>'`
 *   Windows → `"C:/…/node.exe" "C:/…/norya-claude-event.js"` (o Claude roda o
 *             hook por Git Bash ou cmd: aspas duplas e barras normais valem nos
 *             dois). Sem node.exe, sem hook: o prefixo `VAR=1 exe` é sintaxe de
 *             sh e quebraria no cmd — o pane volta pra heurística de bytes.
 */

const nodeFs = require('fs');
const nodePath = require('path');

/**
 * @param {object} o
 * @param {object} o.plat         platform.js (instância)
 * @param {string} o.helper       caminho do helpers/norya-claude-event.js
 * @param {string} [o.nvmDir]     ~/.nvm (só POSIX)
 * @param {string} [o.execPath]   process.execPath (fallback Electron, só POSIX)
 * @param {string} [o.envPath]    PATH do processo (Windows: onde o node.exe pode estar)
 * @param {object} [o.fsImpl]
 * @returns {string|null}
 */
function resolveClaudeHookCmd(o) {
  const plat = o.plat;
  const fs = o.fsImpl || nodeFs;
  const p = plat.path || nodePath;
  try { if (!fs.existsSync(o.helper)) return null; } catch { return null; }

  if (plat.isWin) {
    const dirs = plat.agentPathDirs().slice();
    for (const d of String(o.envPath || '').split(plat.pathSep)) if (d && !dirs.includes(d)) dirs.push(d);
    const node = dirs.map(d => p.join(d, plat.nodeBinName))
      .find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    return node ? plat.hookCommand(node, o.helper) : null;
  }

  const dirs = plat.agentPathDirs();
  if (o.nvmDir) {
    try {
      const vers = fs.readdirSync(p.join(o.nvmDir, 'versions', 'node')).sort().reverse();
      for (const v of vers) dirs.push(p.join(o.nvmDir, 'versions', 'node', v, 'bin'));
    } catch {}
  }
  dirs.push('/usr/bin');
  const node = dirs.map(d => p.join(d, 'node'))
    .find(f => { try { fs.accessSync(f, (fs.constants || nodeFs.constants).X_OK); return true; } catch { return false; } });
  return node
    ? plat.hookCommand(node, o.helper)
    : `ELECTRON_RUN_AS_NODE=1 ${plat.quote(o.execPath)} ${plat.quote(o.helper)}`;
}

module.exports = { resolveClaudeHookCmd };
