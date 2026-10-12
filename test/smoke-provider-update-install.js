'use strict';
// Explicit integration smoke: downloads public Codex packages to a disposable
// prefix. Never updates the user's installed CLI or reads account credentials.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { ProviderUpdates, run, cleanEnv } = require('../agents/updates');
const { AGENTS } = require('../agents/registry');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-codex-install-'));
(async () => {
  const real = new ProviderUpdates();
  const detected = await real.resolve();
  const original = await real.inspect(AGENTS[0], detected.paths, detected.env);
  assert.equal(original.plan.kind, 'npm');
  const prefix = path.join(tmp, 'node');
  fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
  fs.mkdirSync(path.join(prefix,'lib/node_modules'),{recursive:true});
  fs.symlinkSync(original.plan.file,path.join(prefix,'bin/node'));
  fs.symlinkSync(path.dirname(path.dirname(original.plan.npm)),path.join(prefix,'lib/node_modules/npm'));
  const env = cleanEnv();
  env.PATH = `${prefix}/bin:${detected.env.PATH}`;
  // Only this prefix and a temporary npm cache may change.
  env.npm_config_cache = path.join(tmp,'cache');
  const plan = {...original.plan,prefix,file:path.join(prefix,'bin/node'),npm:path.join(prefix,'lib/node_modules/npm/bin/npm-cli.js'),env};
  const oldVersion = process.env.NORYA_UPDATE_TEST_FROM || original.row.current;
  const target = await real.latest(original.row,original.plan);
  assert.notEqual(oldVersion,target,'Integration smoke needs an older starting version');
  const initial = real.installCommand(plan,oldVersion);
  console.log('Installing fixture',oldVersion,'at',prefix);
  await run(initial.file,initial.args,{env,timeout:180000});
  const u = new ProviderUpdates({stateDir:path.join(tmp,'state'),external:async()=>false});
  u.resolve = async()=>({paths:{codex:path.join(prefix,'bin/codex')},env});
  const check = await u.check(true);
  assert.equal(check.providers[0].current,oldVersion);
  assert.equal(check.providers[0].latest,target);
  console.log('Updating fixture through ProviderUpdates',oldVersion,'→',target);
  u.request('codex');
  while(u.active) await new Promise(r=>setTimeout(r,250));
  const result = u.snapshot().providers[0];
  assert.equal(result.status,'current',JSON.stringify(result));
  assert.equal(result.current,target);
  const after = await real.inspect(AGENTS[0],detected.paths,detected.env);
  assert.equal(after.row.current,original.row.current);
  console.log('PASS installed version + app-server handshake; computer installation unchanged at',after.row.current);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
