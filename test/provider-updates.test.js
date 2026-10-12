'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProviderUpdates, compare, cleanEnv, run } = require('../agents/updates');
const QuotaManager = require('../quota');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-updates-test-'));
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function fixture(options = {}) {
  let installed = '1.0.0';
  const calls = [];
  const u = new ProviderUpdates({ stateDir: fs.mkdtempSync(path.join(tmp, 'job-')), sessions: () => 0,
    external: async () => false, validate: async () => {}, ...options });
  const row = {id:'codex', label:'Codex', path:'/test/codex', realPath:'/test/real', current:installed,
    latest:'1.1.0', canUpdate:true, status:'available', checkedAt:Date.now()};
  const plan = {kind:'npm', file:'/test/node', npm:'/test/npm.js', prefix:'/test/prefix', pkg:'@openai/codex', env:{}};
  u.rows[0] = row; u.plans.set('codex', plan);
  u.resolve = async () => ({paths:{codex:row.path},env:{}});
  u.inspect = async () => ({row:{...row,current:installed},plan});
  u.run = async (file,args) => { calls.push({file,args}); installed='1.1.0'; };
  const done = async () => { for(let i=0;i<100 && u.active;i++) await tick(); clearTimeout(u.queueTimer); };
  return {u,row,plan,calls,done,setVersion:v=>installed=v};
}
(async () => {
  await test('semver: numeric segments, prereleases and build metadata', () => {
    assert.equal(compare('0.154.0','0.99.0'),1); assert.equal(compare('1.0.0-alpha.9','1.0.0-alpha.10'),-1);
    assert.equal(compare('1.0.0','1.0.0-rc.1'),1); assert.equal(compare('1.0.0+build','1.0.0'),0);
    assert.throws(()=>compare('latest','1.0.0'));
  });
  await test('updater strips profile credentials, project variables and npm prefix overrides', () => {
    const env = cleanEnv({HOME:'/profile',CODEX_HOME:'/profile/.codex',CLAUDE_CONFIG_DIR:'/profile/.claude',
      OPENAI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret',NPM_CONFIG_PREFIX:'/wrong',NODE_OPTIONS:'--require=bad',PATH:'/bin'}, '/real');
    assert.equal(env.HOME,'/real'); for(const k of ['CODEX_HOME','OPENAI_API_KEY','ANTHROPIC_API_KEY','NPM_CONFIG_PREFIX','NODE_OPTIONS','CLAUDE_CONFIG_DIR']) assert.equal(env[k],undefined);
  });
  await test('only the npm belonging to the resolved prefix may install the exact offered version', () => {
    const {u,plan}=fixture(); const cmd=u.installCommand(plan,'1.1.0');
    assert.equal(cmd.file,'/test/node'); assert.equal(cmd.args[0],'/test/npm.js');
    assert.equal(cmd.args[cmd.args.indexOf('--prefix')+1],'/test/prefix');
    assert.equal(cmd.args.at(-1),'@openai/codex@1.1.0');
    assert.throws(()=>u.installCommand(plan,'1.1.0;touch /tmp/no'));
  });
  await test('successful install must validate actual version before reporting success', async () => {
    const {u,row,calls,done}=fixture(); u.request('codex'); await done();
    assert.equal(calls.length,1); assert.equal(row.current,'1.1.0'); assert.equal(row.status,'current');
    assert.equal(u.jobs.size,0); assert(!fs.existsSync(path.join(u.stateDir,'provider-update.lock')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(u.stateDir,'provider-update-job.json'))).status,'complete');
  });
  await test('hidden/live sessions queue the update without running any installer', async () => {
    let sessions=2; const {u,calls,done}=fixture({sessions:()=>sessions});
    u.request('codex'); await tick(); assert.equal(calls.length,0); assert.equal(u.jobs.get('codex').status,'queued');
    sessions=0; u.wake(); await done(); assert.equal(calls.length,1);
  });
  await test('cancel removes an update queued behind a live session', async () => {
    const {u,calls,done}=fixture({sessions:()=>1}); u.request('codex');u.cancel('codex'); await done();
    assert.equal(calls.length,0); assert.equal(u.jobs.size,0);
  });
  await test('duplicate clicks coalesce and lock only the target provider', async () => {
    const gate=deferred(); const {u,calls,done}=fixture({pause:()=>gate.promise});
    u.request('codex'); u.request('codex'); assert(u.isLocked('codex'));assert(!u.isLocked('claude'));
    gate.resolve();await done();assert.equal(calls.length,1);
  });
  await test('session appearing while probes drain postpones installation', async () => {
    let busy=0; const {u,calls,done}=fixture({sessions:()=>busy,pause:async()=>{busy=1;}});
    u.request('codex');await done();assert.equal(calls.length,0);assert.equal(u.jobs.get('codex').status,'queued');u.cancel('codex');
  });
  await test('external provider processes also postpone installation', async () => {
    const {u,calls,done}=fixture({external:async()=>true});u.request('codex');await done();
    assert.equal(calls.length,0);assert.equal(u.jobs.get('codex').status,'queued');u.cancel('codex');
  });
  await test('version changed outside Norya invalidates a queued offer', async () => {
    const {u,row,calls,done,setVersion}=fixture();setVersion('1.2.0');u.request('codex');await done();
    assert.equal(calls.length,0);assert.equal(row.status,'error');assert.match(row.updateError,/instalação mudou/);
  });
  await test('installer exit 0 with wrong version is an error', async () => {
    const {u,row,done}=fixture();u.run=async()=>'';u.request('codex');await done();
    assert.equal(row.status,'error');assert.match(row.updateError,/esperada 1.1.0/);
  });
  await test('protocol validation failure stays visible and releases locks/probes', async () => {
    let resumed=false; const {u,row,done}=fixture({validate:async()=>{throw Error('handshake-test');},resume:()=>{resumed=true;}});
    u.request('codex');await done();assert.equal(row.status,'error');assert.match(row.updateError,/handshake-test/);assert(resumed);assert(!u.isLocked('codex'));
  });
  await test('permission/disk installer failure never reports success', async () => {
    const {u,row,done}=fixture();u.run=async()=>{throw Error('ENOSPC');};u.request('codex');await done();
    assert.equal(row.status,'error');assert.match(row.updateError,/ENOSPC/);assert.equal(row.canUpdate,false);
  });
  await test('another process holding the disk lock prevents an install', async () => {
    const {u,row,calls,done}=fixture();fs.writeFileSync(path.join(u.stateDir,'provider-update.lock'),JSON.stringify({pid:process.pid}));
    u.request('codex');await done();assert.equal(calls.length,0);assert.match(row.updateError,/Outro atualizador/);
    assert(fs.existsSync(path.join(u.stateDir,'provider-update.lock')));
  });
  await test('interrupted job is diagnosed without automatically reinstalling', () => {
    const dir=fs.mkdtempSync(path.join(tmp,'interrupted-'));
    fs.writeFileSync(path.join(dir,'provider-update-job.json'),JSON.stringify({id:'codex',status:'installing'}));
    const u=new ProviderUpdates({stateDir:dir});assert.match(u.rows[0].updateError,/interrompida/);assert.equal(u.jobs.size,0);
  });
  await test('untrusted/stale/unsupported requests cannot launch commands', () => {
    const {u,row}=fixture();assert.throws(()=>u.request('codex;whoami'));row.checkedAt=1;assert.throws(()=>u.request('codex'));
    row.checkedAt=Date.now();row.canUpdate=false;assert.throws(()=>u.request('codex'));
  });
  await test('offline checks preserve installed identity but never call it updated', async () => {
    const u=new ProviderUpdates({stateDir:tmp,get:async()=>{throw Error('offline');}});
    u.resolve=async()=>({paths:{codex:'/bin/codex'},env:{}});
    u.inspect=async a=>({row:{id:a.id,current:'1.0.0',installed:true},plan:{kind:'npm',pkg:'@openai/codex'}});
    const result=await u.check(true);assert.equal(result.checking,false);
    assert(result.providers.every(p=>p.status==='error' && p.current==='1.0.0' && p.error==='offline'));
  });
  await test('check coalescing and TTL prevent repeated network calls', async () => {
    let calls=0;const gate=deferred();const u=new ProviderUpdates({stateDir:tmp});
    u.resolve=async()=>{calls++;await gate.promise;return{paths:{},env:{}};};
    const a=u.check(true),b=u.check(true);gate.resolve();await Promise.all([a,b]);await u.check();assert.equal(calls,1);
  });
  await test('opening with force bypasses a cached current result', async () => {
    let latest='1.0.0';const u=new ProviderUpdates({stateDir:tmp});
    u.resolve=async()=>({paths:{},env:{}});
    u.inspect=async a=>({row:{id:a.id,current:'1.0.0',installed:true},plan:{kind:'npm'}});
    u.latest=async()=>latest;
    await u.check(true);latest='1.1.0';
    assert.equal((await u.check()).providers[0].status,'current');
    assert.equal((await u.check(true)).providers[0].status,'available');
  });
  await test('failed checks retry after one minute rather than the success TTL', async () => {
    let calls=0;const u=new ProviderUpdates({stateDir:tmp});
    u.resolve=async()=>{calls++;throw Error('offline');};
    await u.check(true);u.checkedAt=Date.now()-61000;await u.check();assert.equal(calls,2);
  });
  await test('old current rows show checking while a new lookup is in flight', async () => {
    const gate=deferred();const u=new ProviderUpdates({stateDir:tmp});
    u.rows[0].status='current';u.resolve=async()=>{await gate.promise;return{paths:{},env:{}};};
    const checking=u.check(true);assert.equal(u.snapshot().providers[0].status,'checking');
    gate.resolve();await checking;
  });
  await test('a version above stable is reported as ahead rather than downgraded', async () => {
    const u=new ProviderUpdates({stateDir:tmp});u.resolve=async()=>({paths:{},env:{}});
    u.inspect=async a=>({row:{id:a.id,current:'2.1.273',channel:'stable'},plan:{kind:'claude'}});
    u.latest=async()=> '2.1.267';const result=await u.check(true);
    assert(result.providers.every(p=>p.status==='ahead'));assert.throws(()=>u.request('claude'));
  });
  await test('Claude npm lookup honors the configured stable channel', async () => {
    let url;const u=new ProviderUpdates({stateDir:tmp,get:async value=>{url=value;return '{"version":"2.1.267"}';}});
    assert.equal(await u.latest({channel:'stable'},{kind:'npm',pkg:'@anthropic-ai/claude-code'}),'2.1.267');assert(url.endsWith('/stable'));
  });
  await test('cancelling while installation discovery awaits prevents the installer', async () => {
    const gate=deferred();const {u,calls,done}=fixture();
    u.resolve=async()=>{await gate.promise;return{paths:{},env:{}};};
    u.request('codex');await tick();u.cancel('codex');gate.resolve();await done();assert.equal(calls.length,0);assert.equal(u.jobs.size,0);
  });
  await test('cancel then requeue preserves the replacement job', async () => {
    const gate=deferred();const {u,calls,done}=fixture();
    u.resolve=async()=>{await gate.promise;return{paths:{},env:{}};};
    u.request('codex');await tick();u.cancel('codex');u.request('codex');
    const replacement=u.jobs.get('codex');gate.resolve();await done();assert.equal(calls.length,0);assert.equal(u.jobs.get('codex'),replacement);
    u.wake();await done();assert.equal(calls.length,1);
  });
  await test('quota pause drains existing probe and refuses even forced probes of that provider', async () => {
    const q=new QuotaManager({getAccountContext:()=>null});const gate=deferred();let calls=0;
    q._doRefresh=()=>{calls++;return gate.promise;};const inflight=q.refresh(1,{provider:'codex'});
    let drained=false;const pause=q.pauseProvider('codex').then(()=>{drained=true;});
    await q.refresh(2,{provider:'codex',force:true});assert.equal(calls,1);assert.equal(drained,false);
    gate.resolve(null);await Promise.all([inflight,pause]);assert(drained);
    q.resumeProvider('codex');await q.refresh(2,{provider:'codex'});assert.equal(calls,2);
  });
  await test('bounded process runner handles errors and terminates timeouts', async () => {
    await assert.rejects(run('/no-such-provider',[]),/ENOENT/);
    await assert.rejects(run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:50}),/Tempo esgotado/);
  });
  console.log(`\n${count} provider update tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
