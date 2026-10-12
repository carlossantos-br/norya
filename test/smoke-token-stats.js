'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-tokens-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-tokens';
process.env.NORYA_SMOKE_PORT = '9231';
fs.mkdirSync(process.env.NORYA_HOME, { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });
const fixture = path.join(process.env.NORYA_HOME, 'accounts/12345/.claude/projects/p/smoke-usage.jsonl');
fs.mkdirSync(path.dirname(fixture), { recursive: true });
fs.writeFileSync(fixture, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'smoke',
  message: { id: 'smoke-usage', model: 'claude-smoke', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } }) + '\n');
const { withApp } = require('./cdp-harness');
(async () => {
  let checks = 0;
  const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
  const r = await withApp(async c => {
    const ipc = await c.evaluate(`(async () => { const s = await api.getTokenStats({force:true}); return {row:s.rows.find(r=>r.key==='claude:smoke-usage:smoke'), errors:s.coverage.errors}; })()`, { timeoutMs: 120000 });
    check('real Electron IPC loads worker and reads an isolated Claude session', () => assert.equal(ipc.row.tokens_used, 115));
    const out = await c.evaluate(`(async () => {
      const d = new Date(); d.setHours(0,0,0,0); const today = Math.max(d.getTime() + 1, Date.now() - 60000);
      const previous = new Date(today); previous.setDate(previous.getDate()-1);
      const b = (input, output, cached, reasoning) => ({input_tokens:input,output_tokens:output,cached_input_tokens:cached,cache_write_input_tokens:0,reasoning_output_tokens:reasoning,total_tokens:input+output});
      const cost = t => ({input:t*0.2,cacheRead:t*0.1,cacheWrite:0,output:t*0.7,webSearch:0,total:t,saved:t/2,long:false,fast:false});
      const rows = [
        {key:'c1', id:'same',provider:'codex',model:'gpt-5.4',accountNum:12,timestamp:today,tokens_used:1234567,_breakdown:b(1200000,34567,1000000,567),cost:cost(10)},
        {key:'c2', id:'same',provider:'codex',model:'gpt-5.4',accountNum:12,timestamp:previous.getTime(),tokens_used:100,_breakdown:b(90,10,50,2),cost:cost(2.5)},
        {key:'a1', id:'claude',provider:'claude',model:'claude-opus-5',accountNum:null,timestamp:today,tokens_used:300,_breakdown:b(250,50,100,10),cost:cost(1)},
        {key:'x1', id:'x',provider:'codex',model:'codex-auto-review',accountNum:12,timestamp:today,tokens_used:5000,_breakdown:b(4000,1000,0,0),cost:null},
        {key:'db', id:'old',provider:'codex',model:'old',accountNum:null,timestamp:null,tokens_used:999,_breakdown:null,cost:null}
      ];
      let calls=0;
      api.getFxUsdBrl=async()=>({rate:5,date:'2026-10-02',source:'PTAX/BCB'});
      api.getTokenStats=async()=>{ calls++; return {rows,updatedAt:Date.now(),coverage:{files:3,issues:0,errors:[],undated:1},
        pricing:{verifiedAt:'2026-10-04',sources:{},table:[]},providers:[
        {id:'codex',label:'Codex',supported:true},{id:'claude',label:'Claude Code',supported:true},{id:'opencode',label:'OpenCode',supported:true},
        {id:'grok',label:'Grok Build',supported:false,reason:'Sem coletor verificável'}, {id:'aider',label:'Aider',supported:false,reason:'Sem registro exato'}]}; };
      _statsFx=null; _statsSnapshot=null;
      openSettings('stats');
      await new Promise(r=>setTimeout(r,150));
      const sp=t=>t&&t.replace(/\\s/g,' ');
      const hero=()=>sp(document.querySelector('.stats-hero-value')?.textContent);
      const tokens=()=>document.querySelector('.stats-kpi-val')?.title;
      const text=()=>document.getElementById('statsContent').textContent;
      const result={hero:hero(), tokens:tokens(), brl:sp(document.querySelector('.stats-hero-brl')?.textContent),
        unpricedRow:[...document.querySelectorAll('.stats-model-table tbody tr')].find(tr=>tr.textContent.includes('codex-auto-review'))?.querySelector('td.num.muted')?.textContent,
        unpricedNote:text().includes('ficaram fora do custo'), notBill:text().includes('Assinaturas não cobram assim'),
        appHidden:getComputedStyle(document.getElementById('app')).visibility};
      document.querySelector('.stats-filter-btn[data-filter="today"]').click();
      result.today=[hero(), tokens()];
      result.undated=text().includes('sem data ficam fora de períodos');
      document.querySelector('.stats-provider-btn[data-provider="claude"]').click();
      result.claude=[hero(), tokens()];
      result.onlyClaude=document.querySelectorAll('.stats-model-table tbody tr').length===1;
      document.querySelector('.stats-provider-btn[data-provider="all"]').click();
      document.querySelector('.stats-filter-btn[data-filter="custom"]').click();
      const date=previous.getFullYear()+'-'+String(previous.getMonth()+1).padStart(2,'0')+'-'+String(previous.getDate()).padStart(2,'0');
      document.getElementById('statsDateFrom').value=date;
      document.getElementById('statsDateTo').value=date;
      document.getElementById('statsDateFrom').dispatchEvent(new Event('change'));
      result.custom=[hero(), tokens()];
      result.localBoundary=filterRowsByDate([{timestamp:new Date(date+'T00:00:00').getTime()},{timestamp:new Date(date+'T23:59:59.999').getTime()},{timestamp:new Date(date+'T00:00:00').getTime()-1}], 'custom',date,date).length;
      document.querySelector('.stats-filter-btn[data-filter="all"]').click();
      document.getElementById('statsRefresh').click(); await new Promise(r=>setTimeout(r,100));
      result.refreshed=calls;
      result.allAgain=hero();
      api.getTokenStats=async()=>{throw new Error('offline-test')};
      await loadStats(true);
      result.errorVisible=!!document.querySelector('.stats-error'); result.stalePreserved=hero();
      return result;
    })()`);
    check('custo de API somado só dos modelos com preço, em USD e BRL', () => {
      assert.equal(out.hero, 'US$ 13,50'); assert.equal(out.brl, '≈ R$ 68');
    });
    check('tokens exatos no tooltip incluem histórico sem detalhamento', () => assert.equal(out.tokens, '1.240.966 tokens'));
    check('modelo sem preço público aparece como "sem preço" e é explicado', () => {
      assert.equal(out.unpricedRow, 'sem preço'); assert.equal(out.unpricedNote, true);
    });
    check('custo é rotulado como equivalente de API, não fatura', () => assert.equal(out.notBill, true));
    check('Settings cobre a janela: app por baixo fica oculto', () => assert.equal(out.appHidden, 'hidden'));
    check('hoje usa a data de cada resposta', () => assert.deepEqual(out.today, ['US$ 11,00', '1.239.867 tokens']));
    check('sem data fica explícito fora de períodos', () => assert.equal(out.undated, true));
    check('filtro Claude mostra só Claude', () => { assert.deepEqual(out.claude, ['US$ 1,00', '300 tokens']); assert.equal(out.onlyClaude, true); });
    check('datas personalizadas respeitam o calendário local', () => { assert.deepEqual(out.custom, ['US$ 2,50', '100 tokens']); assert.equal(out.localBoundary, 2); });
    check('atualizar recarrega', () => { assert.ok(out.refreshed >= 2); assert.equal(out.allAgain, 'US$ 13,50'); });
    check('falha de leitura mantém a última leitura e avisa', () => { assert.equal(out.errorVisible, true); assert.equal(out.stalePreserved, 'US$ 13,50'); });
    await c.evaluate(`document.querySelector('.stats-error')?.remove()`);
    const screenshot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/norya-token-stats-smoke.png', Buffer.from(screenshot.result.data, 'base64'));
  }, { port: 9231 });
  check('no uncaught renderer exceptions', () => assert.deepEqual(r.exceptions, []));
  console.log(`${checks} checks passed`);
  fs.rmSync(ISO, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
