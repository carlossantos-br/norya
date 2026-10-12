'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const { Terminal } = require('@xterm/headless');
const R = require('../renderer/term-replay');
const redraw = require('../renderer/tui-redraw');
const write = (t, s) => new Promise(r => t.write(s, r));
const screen = t => Array.from({length:t.buffer.active.length}, (_,y) => t.buffer.active.getLine(y).translateToString(true)).join('\n');
let count=0;
async function test(name, fn) { await fn(); console.log('PASS '+name);count++; }
(async()=>{
  await test('resizes never overtake asynchronous output; live bytes wait for replay',async()=>{
    const reference=new Terminal({allowProposedApi:true,cols:40,rows:10});
    const a='A'.repeat(36)+'\r\n'+'B'.repeat(36)+'\r\n\x1b[2A\rCHANGED';
    const b='\r\nsmall frame\r\n';
    await write(reference,a);reference.resize(20,8);await write(reference,b);reference.resize(60,12);await write(reference,'live');
    const history=R.createHistory({cols:40,rows:10});history.write(a);history.resize(20,8);history.write(b);history.resize(60,12);
    const wrong=new Terminal({allowProposedApi:true,cols:60,rows:12});await write(wrong,a+b+'live');
    assert.notEqual(screen(wrong),screen(reference),'negative control must reproduce lost resize history');
    const actual=new Terminal({allowProposedApi:true,cols:80,rows:24});const stream=R.createStream(actual);
    stream.replay(history.snapshot());await new Promise(r=>stream.write('live',r));
    assert.equal(screen(actual),screen(reference));assert.equal(actual.cols,60);assert.equal(actual.rows,12);
    for(const t of [reference,wrong,actual])t.dispose();
  });
  await test('history stays bounded and preserves geometry after truncation',()=>{
    const h=R.createHistory({cols:40,rows:10},30);h.write('a'.repeat(50));h.resize(20,8);h.write('\x1b[2Jnew');
    const chunks=h.snapshot();assert(chunks.reduce((n,c)=>n+c.text.length,0)<=30);
    assert.equal(chunks.at(-1).cols,20);assert.equal(chunks.map(c=>c.text).join(''),'\x1b[2Jnew');
  });
  await test('disposing a stream prevents delayed replay resizes and callbacks',()=>{
    let callback;const calls=[];const stream=R.createStream({write:(s,cb)=>{calls.push(s);callback=cb;},resize:()=>calls.push('resize')});
    stream.write('pending');stream.resize(40,10);stream.write('tail');stream.dispose();callback();assert.deepEqual(calls,['pending']);
  });
  await test('menu overflow is detected across every possible PTY chunk boundary',()=>{
    const data='\x1b[20A';
    for(let split=1;split<data.length;split++){
      let nudges=0;const g=redraw.criarGuardaRepintura({repintar:()=>nudges++});g.armar();
      g.aposEscrita({data:data.slice(0,split),rows:16});g.aposEscrita({data:data.slice(split),rows:16});
      assert.equal(nudges,1,`split ${split}`);
    }
    for(const key of ['\t','\x1b[Z',' ','2'])assert(redraw.ehTeclaDeNavegacao(key));
  });
  const source=fs.readFileSync(require.resolve('../renderer/core.js'),'utf8');
  const resizeSource=source.slice(source.indexOf('function setupXtermResize('),source.indexOf('function terminalReplayChunks('));
  function fixture(){
    let id=0;const timers=new Map(),frames=new Map(),sent=[],sized=[];
    const ctx={st:{termSizes:{},termHistory:{}},api:{resize:(...args)=>sent.push(args)},NoryaTuiRedraw:redraw,
      DEBOUNCE:{XTERM_FIT_LAYOUT_RETRY:120,XTERM_FIT_DEFAULT:80,XTERM_FIT_RESIZE_OBS:120,XTERM_FIT_INITIAL:50},
      setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i),
      requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:i=>frames.delete(i)};
    vm.createContext(ctx);vm.runInContext(resizeSource,ctx);
    let dims={cols:60,rows:20};const term={cols:120,rows:35,resize:(...s)=>sized.push(s)};
    const c=ctx.setupXtermResize('test',term,{proposeDimensions:()=>dims},{clientWidth:800,clientHeight:600});
    const flush=map=>{const f=[...map.values()];map.clear();f.forEach(fn=>fn());};
    return{c,ctx,timers,frames,sent,sized,flush,setDims:d=>dims=d};
  }
  await test('invalid transient geometry never resizes xterm or PTY',()=>{
    const f=fixture();f.setDims({cols:2,rows:1});f.c.fitAndResize();f.flush(f.frames);assert.equal(f.sized.length,0);assert.equal(f.sent.length,0);
    f.setDims({cols:60,rows:20});f.c.fitAndResize();f.flush(f.frames);assert.deepEqual(f.sized,[[60,20]]);assert.equal(f.sent.length,1);f.c.cleanup();assert.equal(f.timers.size,0);
  });
  await test('a real layout change cancels a pending menu nudge restore',()=>{
    const f=fixture();f.c.fitAndResize();f.flush(f.frames);f.c.nudge();assert.deepEqual(f.sized.at(-1),[60,19]);
    f.setDims({cols:80,rows:24});f.c.fitAndResize();f.flush(f.frames);f.flush(f.timers);f.flush(f.frames);
    assert.deepEqual(f.sized.at(-1),[80,24]);f.c.nudge();assert.deepEqual(f.sized.at(-1),[80,23]);f.c.cleanup();assert.equal(f.timers.size,0);
  });
  await test('hidden panes stop retrying and cleanup cancels every timer',()=>{
    const f=fixture();f.setDims({cols:2,rows:1});for(let i=0;i<30;i++){f.flush(f.timers);f.flush(f.frames);}assert.equal(f.timers.size,0);assert.equal(f.sent.length,0);f.c.cleanup();
  });
  console.log(`${count} terminal stream tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
