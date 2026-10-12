/**
 * Unit: o probe de quota do Claude usa o prelúdio de PATH canônico injetado.
 *
 * Bug original (2026-07-21): o initCmd só sourçava nvm + brew — mas o
 * `claude` vive em ~/.local/bin, então com o app aberto pelo Finder (PATH
 * mínimo do launchd) o PTY escondido morria com exit 127 e a quota nunca
 * atualizava (painel mostrava números velhos do cache).
 */
'use strict';

const assert = require('assert');
const ClaudeStatusFetcher = require('../quota/claude-status');

let captured = null;
const fakePty = {
  spawn(shell, args, opts) {
    captured = { shell, args, opts };
    return { onData() {}, onExit() {}, write() {}, kill() {} };
  },
};

const ctx = { num: 1, dir: '/tmp', env: {}, authMode: 'claude', shell: '/bin/zsh', nvmScript: '/nonexistent/nvm.sh' };

(async () => {
  // 1) Com shellPrelude injetado: initCmd = prelúdio + "; claude".
  const prelude = 'export PATH="/Users/x/.local/bin:/Users/x/.grok/bin:/opt/homebrew/bin:$PATH"';
  const f1 = new ClaudeStatusFetcher({
    getAccountContext: () => ctx,
    pty: fakePty,
    parser: { parseClaudeStatus: () => null },
    shellPrelude: () => prelude,
  });
  const snap1 = await f1.fetch(1, { timeoutMs: 30 });
  assert.ok(captured, 'pty.spawn não foi chamado');
  const initCmd1 = captured.args[captured.args.length - 1];
  assert.ok(initCmd1.includes('.local/bin'), `initCmd sem ~/.local/bin: ${initCmd1}`);
  assert.ok(initCmd1.endsWith('; claude'), `initCmd não termina lançando claude: ${initCmd1}`);
  assert.strictEqual(snap1.errorKind, 'timeout', 'sem dados o snapshot deveria expirar');

  // 2) Sem shellPrelude (testes antigos): mantém o fallback nvm+brew.
  captured = null;
  const f2 = new ClaudeStatusFetcher({
    getAccountContext: () => ctx,
    pty: fakePty,
    parser: { parseClaudeStatus: () => null },
  });
  await f2.fetch(1, { timeoutMs: 30 });
  const initCmd2 = captured.args[captured.args.length - 1];
  assert.ok(initCmd2.includes('nvm.sh'), `fallback sem nvm: ${initCmd2}`);
  assert.ok(initCmd2.includes('brew shellenv'), `fallback sem brew: ${initCmd2}`);

  console.log('claude-status-prelude: OK (2 casos)');
  // O fetch arma um setTimeout de 2,5s (envio do /usage) que segura o event
  // loop mesmo depois do resolve; sai explícito para o teste não "pendurar".
  process.exit(0);
})().catch(err => { console.error('claude-status-prelude: FALHOU —', err.message); process.exit(1); });
