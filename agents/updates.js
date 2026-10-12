'use strict';

// Provider installations belong to the OS user, never to an account/project.
// No Electron dependency: the main process injects session/probe coordination.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const platform = require('../platform').makePlatform({ homedir: os.userInfo().homedir });
const { AGENTS } = require('./registry');
const TTL = 15 * 60 * 1000;
const ERROR_TTL = 60 * 1000;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/;

function version(text) {
  const v = String(text).trim().replace(/^v/, '');
  if (!VERSION.test(v)) throw new Error('Versão inválida recebida do provider.');
  return v;
}
function compare(a, b) {
  const x = version(a).match(VERSION), y = version(b).match(VERSION);
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1;
  if (x[4] === y[4]) return 0;
  if (!x[4] || !y[4]) return x[4] ? -1 : 1;
  const p = x[4].split('.'), q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn && qn) return +p[i] > +q[i] ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}
function cleanEnv(source = process.env, home = platform.home) {
  const env = {};
  for (const k of ['PATH', 'Path', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData']) {
    if (source[k]) env[k] = source[k];
  }
  Object.assign(env, platform.profileHomeEnv(home), { HOME: home, NO_COLOR: '1', DISABLE_AUTOUPDATER: '1' });
  return platform.prependPath(env, platform.agentPathDirs());
}
function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '', failure;
    const child = spawn(file, args, platform.spawnOpts({ cwd: platform.home, env: cleanEnv(),
      ...opts, detached: platform.detachGroup, stdio: ['pipe', 'pipe', 'pipe'] }));
    const kill = () => {
      try { platform.killTree(child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => { failure = new Error('Tempo esgotado. Verifique a conexão e tente novamente.'); kill(); }, opts.timeout || 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', d => {
      out += d;
      if (out.length > 2 * 1024 * 1024) { failure = new Error('Resposta excedeu o limite.'); kill(); }
    });
    child.stderr.on('data', d => { err = (err + d).slice(-6000); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure || new Error(err.trim() || `${path.basename(file)} terminou com código ${code}.`));
      else resolve(out.trim());
    });
    if (opts.onSpawn) { try { opts.onSpawn(child.pid); } catch (e) { failure = e; kill(); } }
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Norya-provider-updates', Accept: 'application/json, text/plain', 'Cache-Control': 'no-cache', Pragma: 'no-cache' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Redirecionamento inseguro.'));
        get(next.href, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Não foi possível consultar a versão (HTTP ${res.statusCode}).`)); return; }
      let data = '';
      res.on('data', d => { data += d; if (data.length > 2 * 1024 * 1024) req.destroy(new Error('Resposta muito grande.')); });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Consulta expirou. Verifique a conexão.')), 15000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }

class ProviderUpdates extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.run = opts.run || run;
    this.get = opts.get || get;
    this.home = opts.home || platform.home;
    // Injetáveis para o teste provar o caminho do Windows rodando no Mac.
    this.platform = opts.platform || platform;
    this.realpath = opts.realpath || fs.realpathSync;
    this.sessions = opts.sessions || (() => 0);
    this.pause = opts.pause || (async () => {});
    this.resume = opts.resume || (() => {});
    this.external = opts.external || (id => this.externalProcesses(id));
    this.validate = opts.validate || (row => this.validateCLI(row));
    this.stateDir = opts.stateDir || path.join(this.home, '.norya');
    this.rows = AGENTS.map(a => ({ id: a.id, label: a.label, docs: a.docs, status: 'unchecked', installed: false }));
    this.plans = new Map();
    this.jobs = new Map();
    this.active = null;
    this.checking = null;
    this.checkedAt = 0;
    try {
      const old = readJson(path.join(this.stateDir, 'provider-update-job.json'));
      if (['installing', 'validating'].includes(old.status)) {
        const row = this.rows.find(r => r.id === old.id);
        if (row) row.updateError = 'A atualização anterior foi interrompida. Verifique a versão instalada antes de tentar novamente.';
      }
    } catch {}
  }
  snapshot() { return { checkedAt: this.checkedAt, checking: !!this.checking,
    providers: this.rows.map(r => ({ ...r, sessions: this.sessions(r.id), job: this.jobs.get(r.id)?.status || null })) }; }
  changed() { this.emit('change', this.snapshot()); }
  isLocked(id) { return this.active === id; }
  async resolve() {
    const probes = AGENTS.map(a => platform.probeCommand(a.id, a.bin));
    probes.push(platform.isWin ? '"__path`t$env:PATH"' : 'printf "__path\\t%s\\n" "$PATH"');
    const cmd = platform.joinCmds([platform.agentShellPrelude(), ...probes]);
    const output = await this.run(platform.shellBin(), platform.shellArgsNonInteractive(cmd), { env: cleanEnv(process.env, this.home), cwd: this.home });
    const paths = Object.fromEntries(output.split('\n').map(l => l.trim().split('\t')).filter(p => p.length === 2));
    const env = cleanEnv(process.env, this.home);
    if (paths.__path) env.PATH = paths.__path;
    return { paths, env };
  }
  async inspect(agent, paths, env) {
    const platform = this.platform;
    const bin = paths[agent.id];
    const row = { id: agent.id, label: agent.label, docs: agent.docs, installed: !!bin, path: bin || null,
      current: null, latest: null, channel: null, origin: null, canUpdate: false, status: bin ? 'checking' : 'missing' };
    if (!bin) return { row };
    const real = this.realpath(bin);
    row.realPath = real;
    let plan;
    const npmName = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', opencode: 'opencode-ai' }[agent.id];
    const marker = npmName && `${path.sep}lib${path.sep}node_modules${path.sep}${npmName}${path.sep}`;
    if (marker && real.includes(marker) && !platform.isWin) {
      const prefix = real.slice(0, real.indexOf(marker));
      const pkg = readJson(path.join(prefix, 'lib/node_modules', npmName, 'package.json'));
      if (pkg.name !== npmName) throw new Error('Pacote instalado não corresponde ao provider.');
      const node = path.join(prefix, 'bin/node');
      const npm = path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
      row.origin = 'npm'; row.channel = 'latest'; row.prefix = prefix;
      plan = { kind: 'npm', file: node, npm, prefix, pkg: npmName, env: { ...env, PATH: `${path.dirname(node)}${platform.pathSep}${env.PATH}` } };
      if (!fs.existsSync(node) || !fs.existsSync(npm)) plan = null;
    } else if (real.includes('/Cellar/')) {
      const match = real.match(/^(.*)\/Cellar\/([^/]+)\/([^/]+)/);
      const receipt = readJson(path.join(match[0], 'INSTALL_RECEIPT.json'));
      const tap = receipt.source?.tap;
      row.origin = 'Homebrew'; row.channel = 'stable'; row.formula = tap === 'homebrew/core' ? match[2] : `${tap}/${match[2]}`;
      row.current = version(match[3].replace(/_\d+$/, ''));
      row.revision = Number(match[3].match(/_(\d+)$/)?.[1] || 0);
      plan = { kind: 'brew', tap, name: match[2], file: path.join(match[1], 'bin/brew'), env };
    } else if (agent.id === 'claude' && real.startsWith(path.join(this.home, '.local/share/claude/versions') + path.sep)) {
      row.origin = 'Instalador Claude'; row.channel = 'latest';
      try { const channel = readJson(path.join(this.home, '.claude/settings.json')).autoUpdatesChannel; if (['stable', 'latest'].includes(channel)) row.channel = channel; } catch {}
      plan = { kind: 'claude', file: bin, env };
    } else if (agent.id === 'grok' && real.startsWith(path.join(this.home, '.grok') + path.sep)) {
      row.origin = 'Instalador Grok';
      plan = { kind: 'grok', file: bin, env };
    } else { row.origin = 'Instalação não reconhecida'; }
    // Windows: o `Get-Command` devolve o shim do npm (`claude.ps1`/`.cmd`), que o
    // spawn sem shell não executa (EINVAL). `runnable` lê o shim e devolve o
    // `node.exe <cli.js>` que ele rodaria; sem isso, nem tenta (antes: exceção
    // que derrubava a linha inteira em "erro"). No POSIX é o próprio binário.
    const launch = row.current ? null : platform.runnable(bin, { envPath: env.PATH });
    if (launch) {
      const output = await this.run(launch.file, [...launch.args, '--version'], { env });
      const found = output.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/);
      if (!found) throw new Error('O executável não informou uma versão reconhecida.');
      row.current = version(found[0]);
    }
    if (agent.id === 'claude' && ['npm', 'claude'].includes(plan?.kind)) {
      try {
        const channel = readJson(path.join(this.home, '.claude/settings.json')).autoUpdatesChannel;
        if (['stable', 'latest'].includes(channel)) row.channel = channel;
      } catch (e) {
        if (e.code !== 'ENOENT') throw new Error('Não foi possível ler o canal do Claude em settings.json.');
      }
    }
    if (platform.isWin || !plan) {
      row.status = 'unsupported'; row.message = 'Consulte as instruções do provider para esta instalação.';
      return { row };
    }
    // Do not silently move an alpha/beta installation onto the latest channel.
    if (row.current.includes('-') && plan.kind !== 'grok') {
      row.status = 'unsupported'; row.message = 'Versão de pré-lançamento: mantenha o canal pelo instalador original.';
      return { row };
    }
    return { row, plan };
  }
  async latest(row, plan) {
    if (plan.kind === 'npm') return version(JSON.parse(await this.get(`https://registry.npmjs.org/${encodeURIComponent(plan.pkg)}/${row.channel || 'latest'}`)).version);
    if (plan.kind === 'claude') return version(await this.get(`https://downloads.claude.ai/claude-code-releases/${row.channel}`));
    if (plan.kind === 'grok') {
      const data = JSON.parse(await this.run(plan.file, ['update', '--check', '--json'], { env: plan.env }));
      if (data.error || !['stable', 'alpha'].includes(data.channel) || data.installer !== 'internal') throw new Error(data.error || 'Canal/instalador Grok não reconhecido.');
      row.channel = data.channel;
      return version(data.latestVersion);
    }
    if (plan.kind === 'brew' && plan.tap === 'homebrew/core') {
      const data = JSON.parse(await this.get(`https://formulae.brew.sh/api/formula/${encodeURIComponent(plan.name)}.json`));
      row.latestRevision = Number(data.revision || 0);
      return version(data.versions.stable);
    }
    if (plan.kind === 'brew' && row.id === 'opencode' && plan.tap === 'anomalyco/tap') {
      const text = await this.get('https://raw.githubusercontent.com/anomalyco/homebrew-tap/HEAD/opencode.rb');
      return version(text.match(/^\s*version\s+"([^"]+)"/m)?.[1]);
    }
    throw new Error('Consulta de versões ainda não suportada para este instalador.');
  }
  async check(force = false) {
    if (this.checking) return this.checking;
    const ttl = this.rows.some(r => r.status === 'error') ? ERROR_TTL : TTL;
    if (this.active || (!force && this.checkedAt && Date.now() - this.checkedAt < ttl)) return this.snapshot();
    for (const row of this.rows) if (!this.jobs.has(row.id)) { row.status = 'checking'; row.canUpdate = false; }
    this.checking = this.performCheck().finally(() => {
      this.checking = null; this.changed(); this.wake();
    }).then(() => this.snapshot());
    this.changed();
    return this.checking;
  }
  async performCheck() {
    try {
      const { paths, env } = await this.resolve();
      await Promise.all(AGENTS.map(async a => {
        let row = { ...this.rows.find(r => r.id === a.id), status: 'error', error: null };
        if (this.jobs.has(a.id)) return;
        this.plans.delete(a.id);
        try {
          const result = await this.inspect(a, paths, env);
          row = { ...result.row, updateError: row.updateError };
          if (result.plan) {
            row.latest = await this.latest(row, result.plan);
            const order = compare(row.current, row.latest);
            row.status = order < 0 || (order === 0 && (row.latestRevision || 0) > (row.revision || 0)) ? 'available' : order > 0 ? 'ahead' : 'current';
            row.canUpdate = result.plan.kind !== 'brew';
            row.manualCommand = result.plan.kind === 'brew'
              ? `${platform.quote(result.plan.file)} update && ${platform.quote(result.plan.file)} upgrade ${platform.quote(row.formula)}` : null;
            this.plans.set(a.id, result.plan);
          }
        } catch (e) { row.status = 'error'; row.error = e.message; }
        row.checkedAt = Date.now();
        this.rows[this.rows.findIndex(r => r.id === a.id)] = row;
        this.changed();
      }));
      this.checkedAt = Date.now();
    } catch (e) {
      this.rows = this.rows.map(r => this.jobs.has(r.id) ? r : ({ ...r, status: 'error', error: e.message, canUpdate: false }));
      this.checkedAt = Date.now();
    }
    return this.snapshot();
  }
  request(id) {
    if (this.checking) throw new Error('Aguarde a consulta de versões terminar.');
    const row = this.rows.find(r => r.id === id);
    if (!row || !row.canUpdate || row.status !== 'available' || !this.plans.has(id)) throw new Error('Busque atualizações antes de instalar.');
    if (this.jobs.has(id)) return this.snapshot();
    if (Date.now() - row.checkedAt > TTL) throw new Error('A consulta expirou. Busque atualizações novamente.');
    // Snapshot the offered target; renderer never sends paths, commands or versions.
    this.jobs.set(id, { status: 'queued', target: row.latest, path: row.path, realPath: row.realPath, current: row.current });
    this.changed();
    this.wake();
    return this.snapshot();
  }
  cancel(id) {
    if (this.jobs.get(id)?.status === 'queued') { this.jobs.delete(id); this.changed(); }
    return this.snapshot();
  }
  wake() {
    if (this.active || this.checking) return;
    clearTimeout(this.queueTimer);
    const entry = [...this.jobs].find(([id, job]) => job.status === 'queued' && this.sessions(id) === 0);
    if (entry) { this.active = entry[0]; this.apply(...entry).catch(() => {}); }
    else if (this.jobs.size) this.queueTimer = setTimeout(() => this.wake(), 5000);
    this.queueTimer?.unref();
  }
  async externalProcesses(id) {
    if (platform.isWin) throw new Error('Atualização integrada ainda não disponível no Windows.');
    const output = await this.run('/bin/ps', ['-axo', 'pid=,comm=']);
    return output.split('\n').some(line => {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      return m && +m[1] !== process.pid && (path.basename(m[2]) === id || (id === 'claude' && m[2].includes('/claude/versions/')) || (id === 'grok' && m[2].includes('/.grok/downloads/')));
    });
  }
  acquireLock(record) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const lock = path.join(this.stateDir, 'provider-update.lock');
    try {
      const old = readJson(lock);
      if (alive(old.pid) || (old.childPid && alive(old.childPid))) throw new Error('Outro atualizador está em execução. Aguarde a conclusão.');
      fs.unlinkSync(lock);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.writeFileSync(lock, JSON.stringify({ ...record, pid: process.pid }), { flag: 'wx', mode: 0o600 });
    return lock;
  }
  async apply(id, job) {
    let lock;
    let deferred = false;
    const row = this.rows.find(r => r.id === id);
    const record = { id, previous: job.current, target: job.target, path: job.path, startedAt: Date.now() };
    const journal = status => {
      record.status = status;
      fs.writeFileSync(path.join(this.stateDir, 'provider-update-job.json'), JSON.stringify(record), { mode: 0o600 });
    };
    const cancelled = () => this.jobs.get(id) !== job;
    try {
      // Pause before any await: no new hidden probes or panes of this provider.
      await this.pause(id);
      if (cancelled()) return;
      const busy = this.sessions(id) || await this.external(id);
      if (cancelled()) return;
      if (busy) { deferred = true; return; }
      lock = this.acquireLock(record);
      const { paths, env } = await this.resolve();
      if (cancelled()) return;
      const fresh = await this.inspect(AGENTS.find(a => a.id === id), paths, env);
      if (cancelled()) return;
      if (fresh.row.path !== job.path || fresh.row.realPath !== job.realPath || fresh.row.current !== job.current || !fresh.plan) {
        throw new Error('A instalação mudou desde a consulta. Busque atualizações novamente.');
      }
      const nowBusy = this.sessions(id) || await this.external(id);
      if (cancelled()) return;
      if (nowBusy) { deferred = true; return; }
      const plan = fresh.plan;
      job.status = 'installing'; row.updateError = null; journal('installing'); this.changed();
      const command = this.installCommand(plan, job.target);
      await this.run(command.file, command.args, { env: command.env, timeout: 10 * 60 * 1000,
        onSpawn: childPid => fs.writeFileSync(lock, JSON.stringify({ ...record, pid: process.pid, childPid }), { mode: 0o600 }) });
      job.status = 'validating'; journal('validating'); this.changed();
      const after = await this.resolve();
      const actual = await this.inspect(AGENTS.find(a => a.id === id), after.paths, after.env);
      if (actual.row.path !== job.path || actual.row.current !== job.target) throw new Error(`A versão executada continua ${actual.row.current || 'indisponível'}; esperada ${job.target}.`);
      await this.validate({ ...actual.row, env: after.env });
      Object.assign(row, actual.row, { latest: job.target, status: 'current', canUpdate: true, checkedAt: Date.now(), updateError: null });
      journal('complete');
      this.emit('installed', id);
    } catch (e) {
      row.updateError = `Não foi possível concluir: ${e.message}`;
      row.status = 'error'; row.canUpdate = false;
      record.error = e.message;
      if (lock) { try { journal('error'); } catch {} }
    } finally {
      if (lock) { try { fs.unlinkSync(lock); } catch {} }
      try { this.resume(id); } catch {}
      this.active = null;
      if (!cancelled()) {
        this.jobs.delete(id);
        if (deferred) this.jobs.set(id, job);
      }
      this.changed();
      if (this.jobs.size) { this.queueTimer = setTimeout(() => this.wake(), 5000); this.queueTimer.unref(); }
    }
  }
  installCommand(plan, target) {
    version(target);
    if (plan.kind === 'npm') return { file: plan.file, args: [plan.npm, 'install', '--global', '--prefix', plan.prefix,
      '--registry=https://registry.npmjs.org', '--userconfig', os.devNull,
      // npm rejects using the same path twice; an absent unique path is empty.
      '--globalconfig', path.join(os.tmpdir(), `norya-empty-${require('crypto').randomUUID()}.npmrc`),
      '--no-audit', '--no-fund', `${plan.pkg}@${target}`], env: plan.env };
    if (plan.kind === 'claude') return { file: plan.file, args: ['install', target], env: plan.env };
    if (plan.kind === 'grok') return { file: plan.file, args: ['update', '--version', target], env: plan.env };
    throw new Error('Use o gerenciador original para atualizar esta instalação.');
  }
  async validateCLI(row) {
    const help = await this.run(row.path, ['--help'], { env: row.env });
    if (!help) throw new Error('A nova versão não inicializou.');
    if (row.id === 'codex') await codexHandshake(row.path, row.env);
  }
}

function codexHandshake(bin, env) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-codex-check-'));
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], platform.spawnOpts({ env: { ...env, CODEX_HOME: dir }, cwd: dir, detached: platform.detachGroup, stdio: ['pipe', 'pipe', 'pipe'] }));
    const stop = () => { try { platform.killTree(child.pid, 'SIGKILL'); } catch {} };
    let data = '', failure, success = false;
    const timer = setTimeout(() => { failure = new Error('A nova versão não respondeu ao app-server.'); stop(); }, 15000);
    const cleanup = () => { clearTimeout(timer); fs.rmSync(dir, { recursive: true, force: true }); };
    child.on('error', e => { cleanup(); reject(e); });
    child.stderr.resume();
    child.stdout.on('data', d => {
      data += d;
      if (data.length > 1024 * 1024) { failure = new Error('Resposta inválida do app-server.'); stop(); return; }
      const lines = data.split('\n'); data = lines.pop();
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== 1) continue;
          if (msg.error || !msg.result) failure = new Error('A nova versão recusou o protocolo app-server.');
          else success = true;
          stop();
        } catch {}
      }
    });
    child.on('close', () => { cleanup(); if (success) resolve(); else reject(failure || new Error('app-server encerrou antes de responder.')); });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'norya_update_check', version: '1.0.0' }, capabilities: {} } }) + '\n');
  });
}

module.exports = { ProviderUpdates, compare, version, cleanEnv, run, get, codexHandshake };
