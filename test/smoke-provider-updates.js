'use strict';
// Runs an isolated Electron instance; no production panes, profile data or CDP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
if (!process.versions.electron) {
  const {spawnSync} = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'norya-update-ui-'));
  const home = path.join(dir,'home');fs.mkdirSync(home);
  const result = spawnSync(require('electron'),[__filename],{env:{...process.env,HOME:os.userInfo().homedir,
    NORYA_HOME:home,NORYA_USER_DATA:path.join(dir,'userdata'),NORYA_SOCKET_SUFFIX:'-updates-smoke',NORYA_SMOKE:'1'},
    encoding:'utf8',timeout:90000});
  process.stdout.write(result.stdout||'');
  if(result.status) process.stderr.write((result.stderr||'').slice(-6000));
  fs.rmSync(dir,{recursive:true,force:true});process.exit(result.status ?? 1);
}
const {app} = require('electron');
const appDir=process.env.NORYA_SMOKE_APP_DIR || path.resolve(__dirname,'..');
app.setAppPath(appDir);
const timeout=setTimeout(()=>{console.error('FAIL UI smoke timed out');app.exit(1);},80000);
app.on('browser-window-created',(_,win)=>{
  win.webContents.once('did-finish-load',async()=>{
    if(!win.webContents.getURL().includes('test-window.html'))return;
    try {
      await new Promise(r=>setTimeout(r,1000));
      const real=await win.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('provider-updates-check',true)`);
      assert.equal(real.providers.length,5);assert.equal(real.checking,false);
      assert(real.providers.find(p=>p.id==='codex').current);
      assert(!real.providers.find(p=>p.id==='codex').path.includes('/accounts/'));
      console.log('PASS real Electron IPC resolves installed providers and finishes checking');
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const ipc=require('electron').ipcRenderer;
        const original=ipc.invoke.bind(ipc);
        let fail=false,installs=0,cancels=0,forced=0;
        const data={checkedAt:Date.now(),checking:false,providers:[
          {id:'codex',label:'Codex',current:'0.153.4',latest:'0.154.0',status:'available',canUpdate:true,origin:'npm',channel:'latest',path:'/Users/test/.nvm/versions/node/v20/bin/codex',sessions:2},
          {id:'claude',label:'Claude Code',current:'2.1.268',latest:'2.1.268',status:'current',origin:'Instalador Claude'},
          {id:'grok',label:'Grok Build',status:'error',error:'Sem conexão com o servidor'},
          {id:'opencode',label:'OpenCode',current:'1.17.18',latest:'1.18.30',status:'available',origin:'Homebrew',manualCommand:'brew update && brew upgrade anomalyco/tap/opencode'},
          {id:'aider',label:'OpenRouter (Aider)',status:'missing',docs:'https://aider.chat/docs/install.html'}]};
        ipc.invoke=async(channel,...args)=>{
          if(!channel.startsWith('provider-updates-'))return original(channel,...args);
          if(channel==='provider-updates-check' && args[0]===true)forced++;
          if(fail)throw new Error('offline-smoke');
          if(channel==='provider-updates-install'){installs++;data.providers[0].job='queued';}
          if(channel==='provider-updates-cancel'){cancels++;data.providers[0].job=null;}
          return structuredClone(data);
        };
        const wait=()=>new Promise(r=>setTimeout(r,60));
        document.getElementById('railUpdates').click();await wait();
        const dialog=document.getElementById('providerUpdatesDialog');
        const result={open:dialog.open,rows:document.querySelectorAll('.provider-update-row').length,
          badge:document.getElementById('providerUpdatesBadge').textContent,
          offline:dialog.textContent.includes('Sem conexão'),
          nextToSettings:document.getElementById('railConfig').nextElementSibling.id==='railUpdates',
          queueLabel:document.querySelector('[data-provider="codex"] button').textContent};
        document.querySelector('[data-provider="codex"] button').click();await wait();
        result.queued=dialog.textContent.includes('Aguardando sessões');
        document.getElementById('providerUpdatesClose').click();
        result.closed=!dialog.open;
        document.getElementById('railUpdates').click();await wait();
        result.queuePreserved=dialog.textContent.includes('Aguardando sessões');
        document.querySelector('[data-provider="codex"] button').click();await wait();
        result.cancelled=!dialog.textContent.includes('Aguardando sessões');
        result.installs=installs;result.cancels=cancels;
        fail=true;document.getElementById('providerUpdatesCheck').click();await wait();
        result.errorVisible=document.getElementById('providerUpdatesError').textContent.includes('offline-smoke');
        result.buttonRecovered=!document.getElementById('providerUpdatesCheck').disabled;
        fail=false;document.getElementById('providerUpdatesCheck').click();await wait();
        result.forced=forced;
        result.widthFits=dialog.getBoundingClientRect().right<=innerWidth;
        return result;
      })()`);
      assert.deepEqual(result,{open:true,rows:5,badge:'2',offline:true,nextToSettings:true,queueLabel:'Atualizar quando livre',
        queued:true,closed:true,queuePreserved:true,cancelled:true,installs:1,cancels:1,errorVisible:true,buttonRecovered:true,forced:4,widthFits:true});
      console.log('PASS UI: adjacent button, badge, 5 rows, queue/cancel, close/reopen, offline and retry');
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const shot=await win.webContents.capturePage();fs.writeFileSync('/tmp/norya-provider-updates-ui.png',shot.toPNG());
      console.log('Screenshot: /tmp/norya-provider-updates-ui.png');
      clearTimeout(timeout);app.exit(0);
    }catch(e){console.error(e);clearTimeout(timeout);app.exit(1);}
  });
});
require(path.join(appDir,'main.js'));
