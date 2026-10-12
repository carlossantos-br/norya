'use strict';
// Isolated Electron + real PTY. Delays CLI preparation to reproduce the lost
// initial resize, and runs a local shell instead of any model/provider call.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
if(!process.versions.electron){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'norya-tui-smoke-'));
  const result=require('child_process').spawnSync(require('electron'),[__filename],{
    env:{...process.env,NORYA_HOME:path.join(dir,'home'),NORYA_USER_DATA:path.join(dir,'userdata'),NORYA_SOCKET_SUFFIX:'-tui-smoke',NORYA_SMOKE:'1'},
    encoding:'utf8',timeout:60000});
  process.stdout.write(result.stdout||'');if(result.status)process.stderr.write((result.stderr||'').slice(-5000));
  fs.rmSync(dir,{recursive:true,force:true});process.exit(result.status??1);
}
const {app}=require('electron');
const appDir=process.env.NORYA_SMOKE_APP_DIR||path.resolve(__dirname,'..');app.setAppPath(appDir);
const work=path.join(process.env.NORYA_HOME,'work');fs.mkdirSync(work,{recursive:true});
const pty=require(path.join(appDir,'node_modules/node-pty'));const originalSpawn=pty.spawn;
let child,spawnSize,spawnCount=0;
pty.spawn=(file,args,opts)=>{
  if(opts.cwd!==work)return originalSpawn(file,args,opts);
  spawnCount++;
  spawnSize={cols:opts.cols,rows:opts.rows};
  child=originalSpawn('/bin/zsh',['-c','stty size; stty -echo; exec cat'],opts);return child;
};
require(path.join(appDir,'agents/skills')).SkillsLibrary.prototype.prepare=async()=>{
  await new Promise(r=>setTimeout(r,900));return null;
};
const timer=setTimeout(()=>{console.error('FAIL timeout');child?.kill();app.exit(1);},45000);
app.on('browser-window-created',(_,win)=>win.webContents.once('did-finish-load',async()=>{
  if(!win.webContents.getURL().includes('test-window.html'))return;
  try{
    await new Promise(r=>setTimeout(r,800));
    const setup=await win.webContents.executeJavaScript(`(async()=>{
      const acc={num:901,name:'TUI test',dir:${JSON.stringify(work)},authMode:'claude'};
      st.accounts=[acc];st.activeProfileNum=901;st.selectedThreadId='tui-smoke';
      st.allThreads=[{id:'tui-smoke',title:'TUI regression',accountNum:901,cwd:${JSON.stringify(work)}}];
      st.spawnByThread['tui-smoke']='tui-smoke';
      st.gridMode.enabled=true;st.gridMode.threadIds=['tui-smoke'];st.gridMode.focusedThreadId='tui-smoke';
      document.getElementById('app').dataset.view='grid';document.body.classList.remove('landing','onboarding');document.getElementById('app').classList.remove('landing');document.getElementById('newThreadPanel')?.classList.add('hidden');
      launchTerminal(acc,{spawnId:'tui-smoke',agentId:'claude',cwd:${JSON.stringify(work)}});renderGrid();
      await new Promise(r=>setTimeout(r,2400));
      const inst=st.gridCellXterms['tui-smoke'];
      const screen=inst.container.querySelector('.xterm-screen').getBoundingClientRect(), bounds=inst.container.getBoundingClientRect(),style=getComputedStyle(inst.container);
      const fits=screen.right<=bounds.right-parseFloat(style.paddingRight)+1 && screen.bottom<=bounds.bottom-parseFloat(style.paddingBottom)+1;
      return{fits,size:st.termSizes['tui-smoke'],term:{cols:inst.term.cols,rows:inst.term.rows},output:st.termBuffers['tui-smoke'],hidden:!!xtermInstances['tui-smoke']};
    })()`);
    assert.equal(setup.fits,true,'terminal screen must fit inside cell content without clipping');
    assert.equal(setup.hidden,false,'grid output must not create a duplicate hidden xterm');
    assert.deepEqual(spawnSize,setup.size);assert.deepEqual(setup.term,setup.size);
    assert.match(setup.output,new RegExp(`${setup.size.rows} +${setup.size.cols}`));
    console.log('PASS delayed PTY starts with fitted geometry '+JSON.stringify(spawnSize)+'; one xterm per pane');
    const menu=await win.webContents.executeJavaScript(`(async()=>{
      const id='tui-smoke',inst=st.gridCellXterms[id];
      inst.fit.proposeDimensions=()=>({cols:51,rows:16});inst.resize.fitAndResize();
      await new Promise(r=>setTimeout(r,150));
      const frame=selected=>{
        const lines=['Choose an option:',''];
        for(let option=0;option<3;option++){
          lines.push((option===selected?'❯':' ')+(option+1)+'. Option '+(option+1));
          for(let i=0;i<5;i++)lines.push('    description '+i);
        }
        lines.push('','Enter to confirm');return lines.join('\\r\\n');
      };
      const emit=data=>ipcRenderer.emit('terminal-data-'+id,{},data);
      emit('\\x1b[H\\x1b[2J'+frame(0));await new Promise(r=>setTimeout(r,80));
      const original=api.resize,originalInput=api.sendInput;let nudges=0;
      api.sendInput=()=>{};
      api.resize=(sid,c,r)=>{
        if(r===15)nudges++;
        if(r===16)setTimeout(()=>emit('\\r\\n'+frame(2)),10);
      };
      inst.term.input('\\x1b[B',true);
      // Split ESC [ 19 A across IPC messages, like a real PTY read boundary.
      emit('\\x1b[');emit('19');emit('A\\x1b[1G \\x1b[12B\\x1b[1G❯');
      await new Promise(r=>setTimeout(r,180));
      const b=inst.term.buffer.active,text=Array.from({length:inst.term.rows},(_,y)=>b.getLine(b.baseY+y)?.translateToString(true)||'').join('\\n');
      api.resize=original;api.sendInput=originalInput;
      return{nudges,oneMarker:(text.match(/❯/g)||[]).length===1,selected:text.includes('❯3. Option 3'),rows:inst.term.rows};
    })()`);
    assert.deepEqual(menu,{nudges:1,oneMarker:true,selected:true,rows:16});
    console.log('PASS oversized question recovers one correct selection after split redraw bytes');
    const replay=await win.webContents.executeJavaScript(`(async()=>{
      const id='tui-smoke',inst=st.gridCellXterms[id];inst.resize.cleanup();
      const history=NoryaTermReplay.createHistory({cols:40,rows:12});st.termHistory[id]=history;
      const first='A'.repeat(35)+'\\r\\n'+'B'.repeat(35)+'\\r\\n\\x1b[2A\\rMENU';
      history.write(first);history.resize(20,10);history.write('\\r\\nselected option\\r\\n');history.resize(60,15);
      const ref=new Terminal({...noryaTermOptions(),cols:40,rows:12});
      const put=s=>new Promise(r=>ref.write(s,r));await put(first);ref.resize(20,10);await put('\\r\\nselected option\\r\\n');ref.resize(60,15);
      buildGridCellXterm(id,inst.container);const rebuilt=st.gridCellXterms[id];
      await new Promise(r=>rebuilt.stream.write('',r));rebuilt.resize.cleanup();
      const text=t=>Array.from({length:t.buffer.active.length},(_,y)=>t.buffer.active.getLine(y).translateToString(true)).join('\\n');
      const same=text(ref)===text(rebuilt.term);ref.dispose();
      // Temporarily-invalid cell must not mutate either side of the PTY.
      let sent=0;const original=api.resize;api.resize=()=>sent++;
      const term=rebuilt.term,old=[term.cols,term.rows];
      const resize=setupXtermResize(id,term,{proposeDimensions:()=>({cols:2,rows:1})},rebuilt.container);
      resize.fitAndResize();await new Promise(r=>setTimeout(r,40));resize.cleanup();api.resize=original;
      return{same,invalidUnchanged:old[0]===term.cols&&old[1]===term.rows,sent};
    })()`);
    assert.deepEqual(replay,{same:true,invalidUnchanged:true,sent:0});
    console.log('PASS Electron replay preserves mixed widths and tiny layouts cannot desynchronize PTY');
    await win.webContents.executeJavaScript(`api.killTerminal('tui-smoke')`);
    await new Promise(r=>setTimeout(r,200));
    const listeners=await win.webContents.executeJavaScript(`ipcRenderer.listenerCount('terminal-data-tui-smoke')`);
    assert.equal(listeners,0);console.log('PASS terminal exit removes data listeners');
    const before=spawnCount;
    const cancelled=await win.webContents.executeJavaScript(`(async()=>{
      const result=ipcRenderer.invoke('spawn-terminal-checked',{account:st.accounts[0],spawnId:'cancelled-smoke',agentId:'claude',cwd:${JSON.stringify(work)}});
      await new Promise(r=>setTimeout(r,100));api.killTerminal('cancelled-smoke');
      return await result;
    })()`);
    assert.equal(cancelled.code,'cancelled');assert.equal(spawnCount,before);
    console.log('PASS closing a pane during preparation prevents a hidden late PTY');
    clearTimeout(timer);child?.kill();app.exit(0);
  }catch(e){console.error(e);clearTimeout(timer);child?.kill();app.exit(1);}
}));
require(path.join(appDir,'main.js'));
