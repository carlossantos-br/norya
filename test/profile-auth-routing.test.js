'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const profile = { authMode: 'claude' };
const sandbox = {
  path, process: { env: { HOME: '/real', USER: 'real', CODEX_HOME: '/foreign', CLAUDE_CODE_OAUTH_TOKEN: 'foreign' } },
  platform: { isMac: true, profileHomeEnv: dir => ({ HOME: dir }), shellBin: () => '/bin/zsh', shellArgs: x => [x], probePrelude: () => '', execPrefix: 'exec ' },
  NVM_DIR: '/nvm', REAL_HOME: '/real', ACCOUNTS_DIR: '/accounts',
  agentShellPrelude: () => '',
  loadAccounts: () => [{ num: 14, dir: '/accounts/14', quotaProviders: ['codex', 'claude'] }],
  readProfile: () => profile, QuotaManager: { PROVIDER_BY_AUTH: { claude: 'claude' } },
  AGENT_BY_ID: { claude: { creds: { env: 'CLAUDE_CODE_OAUTH_TOKEN' } } },
};
vm.createContext(sandbox);
vm.runInContext(fn('buildAccountEnv') + '\n' + fn('getAccountContext'), sandbox);
let c = sandbox.getAccountContext(14, 'codex');
assert.equal(c.env.HOME, '/accounts/14');
assert.equal(c.env.CODEX_HOME, '/accounts/14/.codex');
assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
assert.equal(sandbox.getAccountContext(14, 'claude').env.HOME, '/real');
profile.claudeOauthToken = 'own';
c = sandbox.getAccountContext(14, 'claude');
assert.equal(c.env.HOME, '/accounts/14');
assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, 'own');
assert.equal(sandbox.getAccountContext(14, 'codex').env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
// The interactive spawn must make the same choice by selected CLI, not profile default.
const start = source.indexOf('      const prof = readProfile(profileNum);', source.indexOf('function spawnTerminal'));
const end = source.indexOf('      // Merge de env vindo do chamador', start);
assert(start >= 0 && end > start);
Object.assign(sandbox, { profileNum: 14, opts: { agentId: 'codex' }, env: sandbox.buildAccountEnv({num:14,dir:'/accounts/14'}).env, agentId: 'codex', resolveAgentId: (auth, id) => id, logLine: () => {} });
vm.runInContext(source.slice(start, end), sandbox);
assert.equal(sandbox.env.HOME, '/accounts/14');
assert.equal(sandbox.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
// A valid 2-hour token used to be rounded to 0 days and labeled expired.
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/profiles.js'), 'utf8');
const rowStart = renderer.indexOf('function providerRowStatus(');
vm.runInContext(renderer.slice(rowStart, renderer.indexOf('\n}', rowStart) + 2), sandbox);
assert(!sandbox.providerRowStatus('claude', {claude:{connected:true, expiresAt:Date.now()+7200000}}).text.includes('expirado'));
assert(sandbox.providerRowStatus('claude', {claude:{connected:true, expiresAt:Date.now()-1}}).text.includes('expirado'));
console.log('profile auth routing + expiry: OK');
