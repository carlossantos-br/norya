#!/usr/bin/env node
/**
 * pet/pet-manager.js — Mini/pet (2026-10-05): ciclo de vida do helper (só com
 * pet=true), protocolo main⇄helper, persistência (pet.json), visibilidade
 * (always / onDemand), atalho global e repasse das ações.
 *
 * Helper falso (EventEmitter com stdin que grava as linhas). Uso:
 *   node test/pet-manager.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PetManager } = require('../pet/pet-manager');

let n = 0;
const t = (nome, fn) => { fn(); console.log(`PASS  ${nome}`); n++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-test-'));
const bin = path.join(dir, 'norya-pet');
fs.writeFileSync(bin, '');
fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
let seq = 0;

function fake(extra) {
  const spawns = [];
  const spawn = () => {
    const p = new EventEmitter();
    p.sent = [];
    p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
    p.stderr = new EventEmitter();
    p.stdin = new EventEmitter();
    p.stdin.write = (l) => { p.sent.push(JSON.parse(l)); };
    p.stdin.end = () => { p.ended = true; };
    p.kill = () => {};
    spawns.push(p);
    return p;
  };
  const ev = { openApp: 0, pills: [], actions: [], closed: 0, opened: 0 };
  const statePath = (extra && extra.statePath) || path.join(dir, `pet-${++seq}.json`);
  let clock = 1000;
  const m = new PetManager(Object.assign({
    binPath: bin, assetsDir: dir, statePath, spawn,
    now: () => (clock += 1000),   // cada chamada avança 1 s: o throttle de escrita nunca segura
    onOpenApp: () => ev.openApp++, onOpenPill: (id) => ev.pills.push(id),
    onAction: (a) => ev.actions.push(a), onClose: () => ev.closed++, onOpen: () => ev.opened++,
  }, extra || {}));
  const ops = (p = spawns[0]) => p.sent.map(x => x.op);
  const emit = (o, p = spawns[0]) => p.stdout.emit('data', JSON.stringify(o) + '\n');
  return { m, spawns, ev, ops, emit, statePath };
}
const pill = (o) => Object.assign({ id: 't1', status: 'running', title: 'Refaça o post', subtitle: 'Pensando' }, o || {});

t('pet=false: nenhum processo, mesmo com estado chegando', () => {
  const { m, spawns } = fake();
  m.setPrefs({ pet: false });
  m.setState({ pet: 'clawd', sprite: 'running', pills: [pill()] });
  assert.strictEqual(spawns.length, 0);
});

t('pet=true sobe o helper UMA vez e manda config + state + show (visibilidade independe de foco/tarefa)', () => {
  const { m, spawns, ops } = fake();
  m.setPrefs({ pet: true, petKind: 'codex', petSize: 150 });
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(ops(), ['config', 'state', 'show']);
  const cfg = spawns[0].sent[0];
  assert.deepStrictEqual([cfg.petKind, cfg.size, cfg.visibility, cfg.badgeCorner, cfg.pillsVisible, cfg.greeted], ['codex', 150, 'always', 'top-end', true, []]);
  assert.deepStrictEqual(cfg.positions, {});
  assert.deepStrictEqual(spawns[0].sent[1], { op: 'state', pet: 'clawd', sprite: 'idle', pills: [] });
});

t('mudar tamanho/tipo na hora reenvia só o config; mesma coisa de novo não reenvia', () => {
  const { m, spawns, ops } = fake();
  m.setPrefs({ pet: true });
  m.setPrefs({ petSize: 200 });
  m.setPrefs({ petSize: 200 });
  m.setPrefs({ petKind: 'none', petSize: 999 });
  assert.deepStrictEqual(ops(), ['config', 'state', 'show', 'config', 'config']);
  assert.strictEqual(spawns[0].sent[3].size, 200);
  assert.deepStrictEqual([spawns[0].sent[4].petKind, spawns[0].sent[4].size], ['none', 224]);   // clamp
  assert.strictEqual(spawns.length, 1);
});

t('state: só quando muda; pílulas saneadas (status inválido sai, canReply/canStop derivados)', () => {
  const { m, spawns, ops } = fake();
  m.setPrefs({ pet: true });
  const s = { pet: 'codex', sprite: 'running', pills: [pill(), pill({ id: 'x', status: 'zzz' }), pill({ id: 'w', status: 'waiting' }), pill({ id: 's', status: 'starting' })] };
  m.setState(s); m.setState(s);
  assert.strictEqual(ops().filter(o => o === 'state').length, 2, 'inicial + 1');
  const st = spawns[0].sent.at(-1);
  assert.deepStrictEqual(st.pills.map(p => [p.id, p.canReply, p.canStop]), [['t1', true, true], ['w', true, false], ['s', false, false]]);
  assert.ok(!('sid' in st.pills[0]) && !('agent' in st.pills[0]), 'só o contrato vai pro helper');
  m.setState({ pet: 'lixo', sprite: 'dançando', pills: [] });
  assert.deepStrictEqual([spawns[0].sent.at(-1).pet, spawns[0].sent.at(-1).sprite], ['clawd', 'idle']);
});

t('desligar (pet=false) fecha o stdin e não deixa processo; religar sobe outro e reenvia tudo', () => {
  const { m, spawns, ops } = fake();
  m.setPrefs({ pet: true });
  m.setState({ pet: 'codex', sprite: 'review', pills: [pill({ status: 'review' })] });
  m.setPrefs({ pet: false });
  assert.ok(spawns[0].ended);
  assert.strictEqual(m.proc, null);
  m.setPrefs({ pet: true });
  assert.strictEqual(spawns.length, 2);
  assert.deepStrictEqual(ops(spawns[1]), ['config', 'state', 'show']);
  assert.strictEqual(spawns[1].sent[1].pills[0].status, 'review', 'o estado do renderer sobrevive ao ciclo');
});

t('onDemand: sobe escondido; atalho mostra e foca; de novo (sem foco) esconde; clique fora do helper = hidden', () => {
  const { m, spawns, ops, emit } = fake();
  m.setPrefs({ pet: true, petVisibility: 'onDemand' });
  assert.deepStrictEqual(ops(), ['config', 'state', 'hide']);
  assert.strictEqual(m.hotkey(), 'show');
  assert.deepStrictEqual(ops().slice(3), ['show', 'focusChat']);
  emit({ ev: 'hidden' });                       // clicou fora
  assert.strictEqual(m.hotkey(), 'show', 'depois de hidden o atalho mostra de novo');
  assert.strictEqual(spawns[0].sent.filter(x => x.op === 'show').length, 2);
  assert.strictEqual(m.hotkey(), 'hide');
  assert.strictEqual(spawns[0].sent.at(-1).op, 'hide');
});

t('atalho: fechado abre (pede onOpen e foca a barra); aberto sem foco foca; com a barra focada solta', () => {
  const { m, spawns, ev, ops, emit } = fake();
  m.setPrefs({ pet: false });
  assert.strictEqual(m.hotkey(), 'open');
  assert.strictEqual(ev.opened, 1);
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(ops(), ['config', 'state', 'show', 'focusChat']);
  assert.strictEqual(m.hotkey(), 'focus');
  emit({ ev: 'chatFocus', focused: true });
  assert.strictEqual(m.hotkey(), 'blur');
  assert.strictEqual(spawns[0].sent.at(-1).op, 'blurChat');
  emit({ ev: 'chatFocus', focused: false });
  assert.strictEqual(m.hotkey(), 'focus');
});

t('"Fechar Mini" ({ev:close}): avisa o main (pet=false), desliga e mata o helper', () => {
  const { m, spawns, ev, emit } = fake();
  m.setPrefs({ pet: true });
  emit({ ev: 'close' });
  assert.strictEqual(ev.closed, 1);
  assert.strictEqual(m.enabled, false);
  assert.ok(spawns[0].ended);
});

t('eventos do helper viram callbacks: openApp, openPill, dismiss, mute, reply, stop, newChat, settings', () => {
  const { m, ev, emit, statePath } = fake();
  m.setPrefs({ pet: true });
  emit({ ev: 'ready' });
  emit({ ev: 'openApp' }); emit({ ev: 'openPill', id: 'abc' });
  emit({ ev: 'dismissPill', id: 'd1' }); emit({ ev: 'mutePill', id: 'm1' });
  emit({ ev: 'reply', id: 'r1', text: 'segue' }); emit({ ev: 'reply', id: 'r1', text: '   ' });
  emit({ ev: 'stop', id: 's1' }); emit({ ev: 'newChat', text: 'faz X' }); emit({ ev: 'newChat', text: '' });
  emit({ ev: 'settings' });
  assert.strictEqual(ev.openApp, 1);
  assert.deepStrictEqual(ev.pills, ['abc']);
  assert.deepStrictEqual(ev.actions, [
    { kind: 'dismiss', id: 'd1' }, { kind: 'mute', id: 'm1' }, { kind: 'reply', id: 'r1', text: 'segue' },
    { kind: 'stop', id: 's1' }, { kind: 'newChat', text: 'faz X' }, { kind: 'settings' },
  ]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).muted, ['m1']);
  assert.deepStrictEqual(m.getMuted(), ['m1']);
});

t('moved: grava por displayId E por resolução; próximo manager manda as posições no config', () => {
  const a = fake();
  a.m.setPrefs({ pet: true });
  a.emit({ ev: 'moved', displayId: 69733382, w: 1512, h: 982, x: 800.4, y: 40 });
  const j = JSON.parse(fs.readFileSync(a.statePath, 'utf8'));
  assert.deepStrictEqual(j.positions, { '69733382': { x: 800, y: 40 }, '1512x982': { x: 800, y: 40 } });
  const b = fake({ statePath: a.statePath });
  b.m.setPrefs({ pet: true });
  assert.deepStrictEqual(b.spawns[0].sent[0].positions['69733382'], { x: 800, y: 40 });
});

t('prefs do helper (badge, pílulas, saudação) persistem e não voltam como config', () => {
  const a = fake();
  a.m.setPrefs({ pet: true });
  const antes = a.spawns[0].sent.length;
  a.emit({ ev: 'prefs', badgeCorner: 'bottom-start', pillsVisible: false, greeted: ['codex', 'codex', 7] });
  a.emit({ ev: 'prefs', badgeCorner: 'meio' });   // inválido: ignorado
  assert.strictEqual(a.spawns[0].sent.length, antes, 'o helper já sabe: nada é reenviado');
  const j = JSON.parse(fs.readFileSync(a.statePath, 'utf8'));
  assert.deepStrictEqual([j.badgeCorner, j.pillsVisible, j.greeted], ['bottom-start', false, ['codex']]);
  a.m.setPrefs({ petSize: 90 });   // mudança de config seguinte já leva os valores novos
  const cfg = a.spawns[0].sent.at(-1);
  assert.deepStrictEqual([cfg.badgeCorner, cfg.pillsVisible, cfg.greeted], ['bottom-start', false, ['codex']]);
});

t('pet.json antigo ({x,y}) e lixo não quebram: padrões', () => {
  const p = path.join(dir, 'velho.json');
  fs.writeFileSync(p, '{"x":10,"y":20}');
  const a = fake({ statePath: p });
  a.m.setPrefs({ pet: true });
  assert.deepStrictEqual(a.spawns[0].sent[0].positions, {});
  fs.writeFileSync(p, '{lixo');
  assert.doesNotThrow(() => fake({ statePath: p }).m.setPrefs({ pet: true }));
});

t('pillError vai pro helper (sem dedupe)', () => {
  const { m, spawns } = fake();
  m.setPrefs({ pet: true });
  m.pillError('t1', 'Não foi possível parar a atividade');
  m.pillError('t1', 'Não foi possível parar a atividade');
  assert.strictEqual(spawns[0].sent.filter(x => x.op === 'pillError').length, 2);
});

t('helper que crasha 3x seguidas não é mais religado; religa sozinho antes disso', () => {
  const { m, spawns } = fake();
  m.setPrefs({ pet: true });
  for (let i = 0; i < 6; i++) { const p = spawns.at(-1); if (m.proc === p) p.emit('exit', 1, null); }
  assert.strictEqual(spawns.length, 3);
});

t('binário ausente desliga sem lançar', () => {
  const m = new PetManager({ binPath: path.join(dir, 'nao-existe'), assetsDir: dir, statePath: path.join(dir, 'p.json') });
  assert.doesNotThrow(() => m.setPrefs({ pet: true }));
  assert.strictEqual(m.enabled, false);
});

t('sem sprites (repo público, sem tools/pet-assets.py) desliga sem lançar', () => {
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sem-sprites-'));
  const m = new PetManager({ binPath: bin, assetsDir: vazio, statePath: path.join(dir, 'p2.json'), spawn: () => { throw new Error('não devia subir'); } });
  assert.doesNotThrow(() => m.setPrefs({ pet: true }));
  assert.strictEqual(m.enabled, false);
  fs.rmSync(vazio, { recursive: true, force: true });
});

t('nenhum timer pendente do próprio manager (leveza): stop() só agenda o kill de segurança, unref', () => {
  const { m } = fake();
  m.setPrefs({ pet: true });
  assert.strictEqual(m.idleTimer, undefined);
  m.stop();
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nTUDO PASSOU (${n}/${n})`);
process.exit(0);
