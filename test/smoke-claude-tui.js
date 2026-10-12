'use strict';
// Exercises local Claude menus; no prompt or model request is sent.
const assert=require('assert/strict'),os=require('os'),path=require('path');
if(!process.versions.electron){
  const result=require('child_process').spawnSync(require('electron'),[__filename],{encoding:'utf8',timeout:50000});
  process.stdout.write(result.stdout||'');if(result.status)process.stderr.write((result.stderr||'').slice(-4000));process.exit(result.status??1);
}
const {app}=require('electron');
const {Terminal}=require('@xterm/headless');
const {cleanEnv}=require('../agents/updates');
const R=require('../renderer/term-replay');
const {buildCommand}=require('../agents/commands');
const platform=require('../platform');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const term=new Terminal({cols:70,rows:20,allowProposedApi:true});const stream=R.createStream(term);
let cli;
function screen(){const b=term.buffer.active;return Array.from({length:term.rows},(_,y)=>b.getLine(b.baseY+y)?.translateToString(true)||'').join('\n');}
async function until(fn){const end=Date.now()+18000;while(Date.now()<end){if(fn())return;await sleep(100);}throw Error('Timed out waiting for Claude local menu:\n'+screen());}
app.whenReady().then(async()=>{
  try{
    const cmd=buildCommand('claude',{skillsPrompt:'Use the Norya skill catalog for skills.'});
    const args=platform.shellArgsNonInteractive(platform.joinCmds([platform.agentShellPrelude(),
      cmd+` --strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '{"disableAllHooks":true}'`]));
    cli=require('node-pty').spawn(platform.shellBin(),args,{cwd:os.userInfo().homedir,env:cleanEnv(),name:'xterm-256color',cols:70,rows:20});
    cli.onData(data=>stream.write(data));
    await until(()=>/bypass permissions/.test(screen()));
    cli.write('/model');await sleep(300);cli.write('\r');
    await until(()=>/Select model/.test(screen()));
    assert(!screen().includes('Unknown command'));
    for(let i=0;i<6;i++){cli.write('\x1b[B');await sleep(120);}
    assert.equal(screen().split('\n').filter(line=>/^\s*❯(?!\s*\/)/.test(line)).length,1,'exactly one selected model');
    console.log('PASS Claude /model remains available with the shared skills prompt and has one selection marker');
    cli.write('\x1b');await sleep(250);cli.write('/config');await sleep(250);cli.write('\r');
    await until(()=>/Settings/.test(screen()) || /Config/.test(screen()));
    assert(!screen().includes('Unknown command'));
    for(const [cols,rows] of [[51,14],[110,30],[51,16]]){
      stream.resize(cols,rows);cli.resize(cols,rows);await sleep(350);
      for(let i=0;i<4;i++){cli.write('\x1b[B');await sleep(100);}
      assert.equal(screen().split('\n').filter(line=>/^\s*❯(?!\s*\/)/.test(line)).length,1,`selection at ${cols}x${rows}:\n${screen()}`);
    }
    console.log('PASS Claude /config and selection survive 51x14, 110x30 and 51x16 resizes');
    cli.kill();stream.dispose();term.dispose();app.exit(0);
  }catch(e){console.error(e);cli?.kill();stream.dispose();term.dispose();app.exit(1);}
});
