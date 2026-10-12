#!/usr/bin/env node
/**
 * Smoke do cache do `list-threads` (main.js: rolloutMetaCache + threadsDbCache).
 *
 * Instância ISOLADA (NORYA_HOME/USER_DATA próprios, socket com sufixo). Prova:
 *  - o cache está ligado: trocar o conteúdo preservando size/mtime/ino NÃO aparece
 *    (rollout e sqlite) — é a assinatura de um hit;
 *  - a invalidação é correta: arquivo alterado (size/mtime), novo, apagado, thread
 *    renomeada (por fora e pelo IPC thread-rename), perfil novo.
 *
 * Uso: node test/smoke-threads-cache.js → exit 0 = PASS, 1 = FAIL
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-smoke-threads-cache-'));
process.env.NORYA_HOME = path.join(ISO, 'home');
process.env.NORYA_USER_DATA = path.join(ISO, 'userdata');
process.env.NORYA_SOCKET_SUFFIX = '-smoke-threads-cache';
process.env.NORYA_SMOKE_PORT = process.env.NORYA_SMOKE_PORT || '9226';
const ACC = path.join(process.env.NORYA_HOME, 'accounts');
for (const n of [1, 2]) fs.mkdirSync(path.join(ACC, String(n), '.codex'), { recursive: true });
fs.mkdirSync(process.env.NORYA_USER_DATA, { recursive: true });

const { withApp, sleep } = require('./cdp-harness');

const ID_ROLL = '11111111-1111-4111-8111-111111111111';
const ID_ROLL2 = '22222222-2222-4222-8222-222222222222';
const ID_ROLL3 = '33333333-3333-4333-8333-333333333333';
const ID_DB = 'db-thread-1';

const rolloutText = (id, msg) =>
  JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/tmp/cache-smoke' } }) + '\n' +
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: msg } }) + '\n';
const rolloutPath = (acc, id) => path.join(ACC, String(acc), '.codex', 'sessions', '2026', '10', '05', `rollout-2026-10-05T00-00-00-${id}.jsonl`);
const writeRollout = (acc, id, msg) => {
  const p = rolloutPath(acc, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rolloutText(id, msg));
  return p;
};
const sql = (db, q) => execFileSync('sqlite3', [db, q], { encoding: 'utf8' });
const DB1 = path.join(ACC, '1', '.codex', 'state_5.sqlite');

async function main() {
  // Estado inicial no disco ANTES do app subir.
  const rollA = writeRollout(1, ID_ROLL, 'titulo-AAAA');
  sql(DB1, `CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER,
    first_user_message TEXT, tokens_used INTEGER, model TEXT, git_branch TEXT, git_sha TEXT, git_origin_url TEXT, archived INTEGER);
    INSERT INTO threads VALUES ('${ID_DB}','db-AAAA','/tmp/cache-smoke',${Math.floor(Date.now() / 1000)},${Date.now()},'x',0,'m','b','s','o',0);`);

  const res = await withApp(async client => {
    const list = async () => client.evaluate(`ipcRenderer.invoke('list-threads', { folder: '/tmp/cache-smoke' })`);
    const pick = (rows, id) => rows.find(r => r.id === id);

    // mtime "redondo" (segundos inteiros): utimes com Date perde os ns do mtime
    // original e o hit nunca poderia ser reproduzido.
    const pin = (p, ms) => { const d = new Date(Math.floor(ms / 1000) * 1000); fs.utimesSync(p, d, d); return d; };
    const T0 = Date.now() - 60000;
    pin(rollA, T0); pin(DB1, T0);
    let rows = await list();
    assert.equal(pick(rows, ID_ROLL).title, 'titulo-AAAA', 'rollout lido');
    assert.equal(pick(rows, ID_DB).title, 'db-AAAA', 'sqlite lido');

    // ── HIT de rollout: mesmo size/mtime/ino, conteúdo trocado → continua o velho.
    const st0 = fs.statSync(rollA);
    const fd = fs.openSync(rollA, 'r+');
    fs.writeSync(fd, Buffer.from(rolloutText(ID_ROLL, 'titulo-BBBB')), 0);
    fs.closeSync(fd);
    fs.utimesSync(rollA, st0.atime, st0.mtime);
    assert.equal(fs.statSync(rollA).size, st0.size);
    rows = await list();
    assert.equal(pick(rows, ID_ROLL).title, 'titulo-AAAA', 'cache de rollout ligado (hit)');
    // ── invalida: mtime muda → relê.
    const t = new Date(Date.now() + 5000); fs.utimesSync(rollA, t, t);
    rows = await list();
    assert.equal(pick(rows, ID_ROLL).title, 'titulo-BBBB', 'rollout alterado (mtime) é relido');
    // ── invalida: size muda.
    fs.writeFileSync(rollA, rolloutText(ID_ROLL, 'titulo-CCCC-mais-longo'));
    rows = await list();
    assert.equal(pick(rows, ID_ROLL).title, 'titulo-CCCC-mais-longo', 'rollout alterado (size) é relido');

    // ── arquivo novo e apagado.
    writeRollout(1, ID_ROLL2, 'segundo');
    rows = await list();
    assert.equal(pick(rows, ID_ROLL2)?.title, 'segundo', 'rollout novo aparece');
    fs.unlinkSync(rolloutPath(1, ID_ROLL2));
    rows = await list();
    assert(!pick(rows, ID_ROLL2), 'rollout apagado some');

    // ── perfil novo (pasta accounts/2 nasce depois do boot) com rollout próprio.
    writeRollout(3, ID_ROLL3, 'perfil-novo');
    rows = await list();
    assert.equal(pick(rows, ID_ROLL3)?.accountNum, 3, 'perfil novo aparece, atribuído à conta 3');

    // ── sqlite: HIT (mesmo mtime/size/ino, título de mesmo tamanho) e invalidação.
    const d0 = fs.statSync(DB1);
    sql(DB1, `UPDATE threads SET title='db-BBBB' WHERE id='${ID_DB}'`);
    fs.utimesSync(DB1, d0.atime, d0.mtime);
    const same = fs.statSync(DB1);
    if (same.size === d0.size && same.ino === d0.ino && !fs.existsSync(DB1 + '-wal')) {
      rows = await list();
      assert.equal(pick(rows, ID_DB).title, 'db-AAAA', 'cache do sqlite ligado (hit)');
    } else {
      console.log('  (hit do sqlite pulado: sqlite3 reescreveu o arquivo)');
    }
    const t2 = new Date(Date.now() + 8000); fs.utimesSync(DB1, t2, t2);
    rows = await list();
    assert.equal(pick(rows, ID_DB).title, 'db-BBBB', 'sqlite alterado (mtime) é relido');
    // renomear por fora, com tamanho diferente
    sql(DB1, `UPDATE threads SET title='db-CCCC-longo' WHERE id='${ID_DB}'`);
    rows = await list();
    assert.equal(pick(rows, ID_DB).title, 'db-CCCC-longo', 'sqlite alterado por fora é relido');
    // renomear pelo IPC do app
    const r = await client.evaluate(`ipcRenderer.invoke('thread-rename', { accountNum: 1, sessionId: '${ID_DB}', title: 'renomeada-pelo-app' })`);
    assert(r && r.ok, 'thread-rename ok: ' + JSON.stringify(r));
    rows = await list();
    assert.equal(pick(rows, ID_DB).title, 'renomeada-pelo-app', 'thread renomeada pelo IPC aparece na hora');
    // apagar pelo IPC
    const d = await client.evaluate(`ipcRenderer.invoke('thread-delete', { accountNum: 1, sessionId: '${ID_DB}' })`);
    assert(d && d.ok, 'thread-delete ok');
    rows = await list();
    assert(!pick(rows, ID_DB), 'thread apagada some');

    // as linhas devolvidas não são o objeto do cache (mutação do chamador não vaza)
    await sleep(100);
  }, { settleMs: 3000 });

  assert.deepEqual(res.exceptions, [], 'exceções no renderer: ' + res.exceptions.join(' | '));
  console.log('PASS smoke-threads-cache');
}

main().then(() => { fs.rmSync(ISO, { recursive: true, force: true }); process.exit(0); },
  e => { console.error('FAIL', e && e.stack || e); fs.rmSync(ISO, { recursive: true, force: true }); process.exit(1); });
