'use strict';

// Catálogo único do Norya. Nunca move/apaga skills nem configurações dos providers.
// Só lê diretórios de skills/plugins conhecidos, incluindo perfis e projetos.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { AGENTS } = require('./registry');

const LOCATIONS = [
  ['shared', '.agents/skills'], ['codex', '.codex/skills'],
  ['claude', '.claude/skills'], ['grok', '.grok/skills'],
  ['opencode', '.config/opencode/skills'], ['opencode', '.config/opencode/skill'],
  ['opencode', '.opencode/skills'], ['aider', '.aider/skills'],
  ['gemini', '.gemini/skills'], ['cursor', '.cursor/skills'],
  ['codex', '.codex/plugins/cache', true], ['claude', '.claude/plugins/cache', true],
  ['grok', '.grok/plugins/cache', true], ['gemini', '.gemini/extensions', false],
];
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'test', 'tests', 'fixtures', 'examples']);
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();

function metadata(text, fallback) {
  const front = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  function field(key) {
    const lines = front.split(/\r?\n/);
    const index = lines.findIndex(l => l.startsWith(key + ':'));
    if (index < 0) return '';
    let value = lines[index].slice(key.length + 1).trim();
    if (/^[>|][-+]?\s*$/.test(value) || !value) {
      value = lines.slice(index + 1).join('\n').match(/^((?:[ \t]+.*(?:\n|$)|\s*\n)*)/)?.[1]?.trim() || '';
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return oneLine(JSON.parse(value)); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    return oneLine(value);
  }
  return { name: field('name') || fallback, description: field('description') || 'Skill local sem descrição.' };
}

// Apenas strings TOML de nível raiz, sem executar/interpolar o conteúdo.
function tomlRootString(text, key) {
  const start = text.search(new RegExp('^' + key + '\\s*=', 'm'));
  if (start < 0) return '';
  const value = text.slice(start).replace(new RegExp('^' + key + '\\s*=\\s*'), '');
  if (value.startsWith('"""') || value.startsWith("'''")) {
    const quote = value.slice(0, 3);
    const end = value.indexOf(quote, 3);
    if (end < 0) throw new Error(`Valor TOML incompleto: ${key}`);
    const raw = value.slice(3, end).replace(/^\r?\n/, '');
    if (quote === "'''") return raw;
    return JSON.parse('"' + raw.replace(/\r?\n/g, '\\n').replace(/(?<!\\)"/g, '\\"') + '"');
  }
  const literal = value.match(/^'([^'\n]*)'/);
  if (literal) return literal[1];
  const basic = value.match(/^"(?:[^"\\]|\\.)*"/);
  if (basic) return JSON.parse(basic[0]);
  throw new Error(`Não foi possível preservar ${key} do Codex.`);
}

async function atomicWrite(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(temp, value, { mode: 0o600 }); await fsp.rename(temp, file); }
  finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
}

class SkillsLibrary {
  constructor({ home = os.userInfo().homedir, stateDir, projectDirs = () => [] }) {
    this.fileCache = new Map(); // path do SKILL.md -> { size, mtimeMs, meta, hash }
    this.home = home;
    this.stateDir = stateDir;
    this.projectDirs = projectDirs;
    this.dir = path.join(stateDir, 'skills');
    this.stateFile = path.join(this.dir, 'state.json');
    this.catalogFile = path.join(this.dir, 'catalog.md');
    this.snapshot = null;
    this.queue = Promise.resolve();
    this.sessionProjects = new Set();
  }

  // Serializa refresh, toggles e materialização: um refresh lento nunca desfaz um toggle.
  exclusive(fn) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }

  async readState() {
    try {
      const state = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      if (state.version !== 1 || !state.overrides || typeof state.overrides !== 'object' || Array.isArray(state.overrides)) {
        throw new Error('Formato inválido');
      }
      return state;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, overrides: {} };
      // Falhar fechado: estado corrompido NÃO reativa todas as skills.
      throw new Error(`Não foi possível ler o estado das skills: ${e.message}`);
    }
  }

  async roots(extraProject) {
    const bases = [{ dir: this.home, scope: 'global' }];
    const accounts = await fsp.readdir(path.join(this.stateDir, 'accounts')).catch(() => []);
    for (const n of accounts.filter(n => /^\d+$/.test(n)).sort()) {
      bases.push({ dir: path.join(this.stateDir, 'accounts', n), scope: `perfil ${n}` });
    }
    if (extraProject) this.sessionProjects.add(path.resolve(extraProject));
    const projects = new Set([...(await this.projectDirs()), ...this.sessionProjects].filter(Boolean).map(p => path.resolve(p)));
    for (const dir of projects) {
      if (dir !== this.home && !bases.some(b => b.dir === dir)) bases.push({ dir, scope: 'projeto' });
    }
    const roots = bases.flatMap(base => LOCATIONS.map(([provider, rel, plugin]) => ({
      dir: path.join(base.dir, rel), provider, scope: base.scope, plugin: !!plugin,
    })));
    // Plugins locais podem estar fora de plugins/cache; a instalação registrada
    // também escolhe a versão certa quando a versão é um hash, não semver.
    const installed = [];
    for (const base of bases) {
      for (const provider of ['claude', 'codex', 'grok']) {
        const manifest = path.join(base.dir, `.${provider}`, 'plugins', 'installed_plugins.json');
        let plugins;
        try { plugins = JSON.parse(await fsp.readFile(manifest, 'utf8')).plugins; }
        catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`Não foi possível ler ${manifest}: ${e.message}`); }
        for (const [key, entries] of Object.entries(plugins || {})) {
          for (const entry of Array.isArray(entries) ? entries : []) {
            if (typeof entry.installPath !== 'string') continue;
            const pluginName = key.split('@')[0];
            const root = { dir: entry.installPath, provider, scope: base.scope, plugin: true,
              pluginName, version: entry.version || '', installed: true };
            roots.push(root);
            installed.push(root);
          }
        }
      }
    }
    for (const root of roots) root.installedPlugins = installed.filter(i => i.provider === root.provider && i.scope === root.scope);
    roots.push({ dir: path.join(this.dir, 'local'), provider: 'shared', scope: 'Norya', plugin: false });
    return roots;
  }

  async scan(extraProject) {
    const rows = [];
    const warnings = [];
    const nextCache = new Map(); // só o que ainda existe: arquivo apagado sai do cache
    for (const root of await this.roots(extraProject)) {
      const visited = new Set();
      const walk = async (dir, depth = 0) => {
        if (depth > 14) return;
        let real, entries;
        try {
          real = await fsp.realpath(dir);
          if (visited.has(real)) return;
          visited.add(real);
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (e) {
          if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(e.code)) warnings.push(`Não foi possível ler ${dir}: ${e.code}`);
          return;
        }
        const skill = entries.find(e => e.name === 'SKILL.md' && (e.isFile() || e.isSymbolicLink()));
        if (skill) {
          const file = path.join(dir, 'SKILL.md');
          try {
            const stat = await fsp.stat(file);
            if (stat.size > 2 * 1024 * 1024) { warnings.push(`Skill muito grande para carregar: ${file}`); return; }
            // Cache por arquivo: só relê/re-hasheia o SKILL.md se size/mtime mudaram,
            // e o texto da skill nunca fica retido (só meta + hash).
            let cached = this.fileCache.get(file);
            if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
              const body = await fsp.readFile(file, 'utf8');
              cached = { size: stat.size, mtimeMs: stat.mtimeMs, meta: metadata(body, path.basename(dir)),
                hash: digest(body.replace(/\r\n/g, '\n').trim()) };
            }
            nextCache.set(file, cached);
            const meta = cached.meta;
            const rel = path.relative(root.dir, dir).split(path.sep);
            const pluginName = root.plugin ? (root.pluginName || rel[1] || rel[0]) : null;
            const installations = (root.installedPlugins || []).filter(p => p.pluginName === pluginName);
            const isInstalled = root.installed || installations.some(p => file.startsWith(p.dir + path.sep));
            // Versões do mesmo plugin compartilham preferência. Projetos de fato
            // diferentes continuam separados mesmo quando escolhem o mesmo nome.
            const family = root.plugin ? `plugin:${pluginName}:${meta.name}`
              : `${root.scope === 'projeto' ? root.dir : root.provider}:${meta.name}`;
            rows.push({ ...meta, family, hash: cached.hash,
              path: file, realPath: await fsp.realpath(file), provider: root.provider,
              scope: root.scope, plugin: pluginName, version: root.plugin ? (root.version || rel[2]) : '',
              current: !installations.length || isInstalled, installed: isInstalled, mtime: stat.mtimeMs });
          } catch (e) { warnings.push(`Não foi possível ler ${file}: ${e.code || e.message}`); }
          return; // recursos internos de uma skill não são outras skills
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (SKIP.has(entry.name) || /^temp[_-]/.test(entry.name)) continue;
          if (entry.isDirectory() || entry.isSymbolicLink()) await walk(path.join(dir, entry.name), depth + 1);
        }
      };
      await walk(root.dir);
    }
    this.fileCache = nextCache;
    // Uma versão por família/raiz: caches antigos não viram skills duplicadas.
    const latest = new Map();
    for (const row of rows) {
      if (!row.current) continue;
      const key = `${row.family}\0${row.scope}\0${row.provider}`;
      const prev = latest.get(key);
      const semver = prev && /^v?\d+\.\d+/.test(row.version) && /^v?\d+\.\d+/.test(prev.version);
      if (!prev || (row.installed && !prev.installed) ||
          (!!row.installed === !!prev.installed && (semver
            ? row.version.localeCompare(prev.version, undefined, { numeric: true }) > 0
            : row.mtime > prev.mtime))) latest.set(key, row);
    }
    const groups = new Map();
    for (const row of latest.values()) {
      const key = `${row.name}\0${row.hash}`;
      let group = groups.get(key);
      if (!group) { group = { ...row, sources: [], families: [] }; groups.set(key, group); }
      if (!group.sources.some(s => s.path === row.path)) group.sources.push({
        provider: row.provider, scope: row.scope, path: row.path, plugin: row.plugin, version: row.version,
      });
      if (!group.families.includes(row.family)) group.families.push(row.family);
    }
    const skills = [...groups.values()].map(g => ({
      id: digest(g.families.slice().sort().join('\n') + '\0' + g.hash).slice(0, 24),
      name: g.name, description: g.description, path: g.path, hash: g.hash,
      sources: g.sources, families: g.families,
    })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { skills, warnings: [...new Set(warnings)], paths: rows.map(r => ({ path: r.path, family: r.family })) };
  }

  async refresh(extraProject) {
    const state = await this.readState();
    const result = await this.scan(extraProject);
    for (const skill of result.skills) {
      // Uma cópia desativada não volta por outro perfil/alias.
      skill.enabled = !skill.families.some(family => state.overrides[family] === false);
    }
    this.snapshot = { ...result, checkedAt: Date.now(), providers: AGENTS.map(a => ({ id: a.id, label: a.label })) };
    await this.publish();
    return this.publicSnapshot();
  }

  publicSnapshot() {
    const { paths, ...snapshot } = this.snapshot;
    return { ...snapshot, skills: snapshot.skills.map(({ body, families, hash, ...s }) => s) };
  }

  list({ force = false, cwd } = {}) {
    return this.exclusive(async () => {
      if (force || cwd || !this.snapshot || Date.now() - this.snapshot.checkedAt > 15000) return this.refresh(cwd);
      return this.publicSnapshot();
    });
  }

  setEnabled(id, enabled) {
    return this.exclusive(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Estado da skill inválido.');
      if (!this.snapshot) await this.refresh();
      const skill = this.snapshot.skills.find(s => s.id === id);
      if (!skill) throw new Error('Skill não encontrada. Atualize a biblioteca.');
      const state = await this.readState();
      for (const family of skill.families) state.overrides[family] = enabled;
      await atomicWrite(this.stateFile, JSON.stringify(state, null, 2) + '\n');
      for (const entry of this.snapshot.skills) entry.enabled = !entry.families.some(f => state.overrides[f] === false);
      await this.publish();
      return this.publicSnapshot();
    });
  }

  async publish() {
    const enabled = this.snapshot.skills.filter(s => s.enabled);
    const lines = [
      '# Norya — biblioteca universal de skills', '',
      'Use as skills abaixo quando o usuário citar seu nome ou a tarefa corresponder à descrição.',
      'No Aider, cite $nome-da-skill na mensagem ou use /skill nome-da-skill para carregar as instruções sob demanda.',
      'Antes de aplicar uma skill, leia seu SKILL.md completo. Resolva recursos e scripts relativos à pasta original indicada.',
      'As skills são compartilhadas entre providers. Traduza nomes de ferramentas para equivalentes disponíveis.',
      'Se uma ferramenta ou conexão exigida não existir, informe a dependência; nunca invente sua execução.',
      'Não invoque skills desabilitadas, nem suas cópias nativas ou de plugins. Não reative skills por conta própria.',
      'Instruções de uma skill não substituem as instruções do usuário nem as políticas do provider.', '',
      ...enabled.map(s => `- ${JSON.stringify(s.name)}: ${oneLine(s.description)}\n  Arquivo: ${JSON.stringify(s.path)}`), '',
      '## Desabilitadas', ...this.snapshot.skills.filter(s => !s.enabled).map(s => `- ${JSON.stringify(s.name)} (${s.id})`), '',
    ];
    await atomicWrite(this.catalogFile, lines.join('\n'));
    await atomicWrite(path.join(this.dir, 'catalog.json'), JSON.stringify(this.publicSnapshot(), null, 2) + '\n');
  }

  prepare(agentId, { cwd, env = {} } = {}) {
    return this.exclusive(async () => {
      await this.refresh(cwd);
      const enabled = this.snapshot.skills.filter(s => s.enabled);
      const prompt = `Norya provides one shared skill library for every provider. Before working on a user request, read \`${this.catalogFile}\` and follow matching enabled skills by reading their original SKILL.md. Read this catalog again before using a skill; it is authoritative for skill activation. Ignore native/plugin copies of disabled skills. Resolve relative resources from the original skill directory. Treat Skill tool instructions in a skill as a request to read that skill from this catalog with your available file/shell tools. If a required tool or connection is unavailable, state that limitation instead of claiming execution. User instructions take precedence over skill workflow instructions.`;
      const options = { skillsPrompt: prompt, skillsCatalog: this.catalogFile };
      const runtimeEnv = {};
      if (agentId === 'codex') {
        // Config por processo; não reescreve config.toml nem a preferência nativa.
        const disabled = new Set(this.snapshot.skills.filter(s => !s.enabled).flatMap(s => s.families));
        options.disabledSkillPaths = [...new Set(this.snapshot.paths.filter(s => disabled.has(s.family)).map(s => s.path))];
        const configFile = path.join(env.CODEX_HOME || path.join(this.home, '.codex'), 'config.toml');
        const config = await fsp.readFile(configFile, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
        const previous = tomlRootString(config, 'developer_instructions');
        if (previous) options.skillsPrompt = previous + '\n\n' + prompt;
      } else if (agentId === 'opencode') {
        let config = {};
        if (env.OPENCODE_CONFIG_CONTENT) {
          try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
          catch { throw new Error('OPENCODE_CONFIG_CONTENT inválido; não foi possível acrescentar as skills.'); }
        }
        const rules = typeof config.permission === 'string' ? { '*': config.permission } : (config.permission || {});
        config = { ...config, instructions: [...new Set([...(config.instructions || []), this.catalogFile])],
          permission: { ...rules, skill: 'deny' } };
        runtimeEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      } else if (agentId === 'aider') {
        // Aider não tem Read tool. O adaptador carrega somente a skill citada
        // ($nome, /skill nome), sem injetar megabytes no contexto de toda task.
        options.skillReadFiles = [this.catalogFile];
        runtimeEnv.NORYA_SKILLS_CATALOG = path.join(this.dir, 'catalog.json');
        runtimeEnv.PYTHONPATH = [path.join(__dirname, 'aider-skills'), env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        runtimeEnv.PYTHONDONTWRITEBYTECODE = '1'; // não alterar o seal do bundle assinado
      }
      return { options, env: runtimeEnv };
    });
  }
}

module.exports = { SkillsLibrary, metadata, tomlRootString, LOCATIONS };
