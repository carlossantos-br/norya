'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SkillsLibrary, metadata, tomlRootString } = require('../agents/skills');
const { buildCommand } = require('../agents/commands');
const { makePlatform } = require('../platform');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-skills-test-'));
  const home = path.join(tmp, 'home');
  const stateDir = path.join(tmp, 'norya');
  const project = path.join(tmp, 'project');
  const put = (relative, name, description = 'Design before implementation', extra = '') => {
    const filename = path.join(home, relative, 'SKILL.md');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `---\nname: ${name}\ndescription: >\n  ${description}\n  with useful questions.\n---\n# ${name}\n${extra}`);
    return filename;
  };
  let n = 0;
  const pass = msg => { console.log('PASS ' + msg); n++; };
  try {
    const brainstorm = put('.claude/plugins/cache/official/superpowers/1.0.0/skills/brainstorming', 'brainstorming');
    const codex = put('.codex/skills/brainstorming', 'brainstorming');
    put('.grok/skills/table', 'table');
    put('.config/opencode/skills/plan', 'plan');
    put('.aider/skills/write', 'write');
    put('.claude/plugins/cache/temp_git_clone/skills/ignore', 'ignore');
    fs.mkdirSync(path.join(stateDir, 'accounts/1/.codex'), { recursive: true });
    fs.symlinkSync(path.join(home, '.codex/skills'), path.join(stateDir, 'accounts/1/.codex/skills'));
    fs.mkdirSync(path.join(home, '.agents/skills'), { recursive: true });
    fs.symlinkSync(path.join(home, '.agents/skills'), path.join(home, '.agents/skills/cycle'));
    const lib = new SkillsLibrary({ home, stateDir, projectDirs: () => [project] });
    let data = await lib.list();
    assert.equal(data.skills.length, 4);
    let skill = data.skills.find(s => s.name === 'brainstorming');
    assert.equal(skill.sources.length, 3);
    assert(data.providers.every(p => ['codex', 'claude', 'grok', 'aider', 'opencode'].includes(p.id)));
    assert(!JSON.stringify(data).includes('"body"'));
    pass('all five provider roots, plugin skills and account symlinks; identical copies grouped; cycles and temporary clones skipped');

    assert.equal(metadata('---\nname: x\ndescription: "a \\"quote\\""\n---\n', 'fallback').name, 'x');
    assert.equal(metadata('---\ndescription: >-\n  First line\n  second line\nname: quoted\n---\n', 'x').description, 'First line second line');
    assert.equal(tomlRootString('developer_instructions = "keep my preference"\n', 'developer_instructions'), 'keep my preference');
    assert.equal(tomlRootString('developer_instructions = """\nline one\nline two\n"""', 'developer_instructions'), 'line one\nline two\n');
    pass('YAML folded descriptions and TOML existing instruction strings');

    await lib.setEnabled(skill.id, false);
    assert(fs.readFileSync(brainstorm, 'utf8').includes('# brainstorming'));
    assert(fs.lstatSync(path.join(stateDir, 'accounts/1/.codex/skills')).isSymbolicLink());
    const reopened = new SkillsLibrary({ home, stateDir });
    data = await reopened.list();
    assert.equal(data.skills.find(s => s.name === 'brainstorming').enabled, false);
    const catalog = fs.readFileSync(lib.catalogFile, 'utf8');
    assert(!catalog.split('## Desabilitadas')[0].includes(brainstorm));
    pass('toggle persists across restart and excludes instructions; originals and symlinks preserved');

    const newer = put('.claude/plugins/cache/official/superpowers/2.0.0/skills/brainstorming', 'brainstorming', 'Updated design', 'New version');
    data = await reopened.list({ force: true });
    const variants = data.skills.filter(s => s.name === 'brainstorming');
    assert.equal(variants.length, 2); // independent local copy and latest plugin now differ
    assert(variants.every(s => !s.enabled));
    assert(variants.some(s => s.path === newer));
    assert(!variants.some(s => s.path === brainstorm));
    pass('plugin updates preserve disabled preference; differing local skill is retained');

    fs.writeFileSync(path.join(home, '.codex/config.toml'), 'developer_instructions = "Keep existing instructions"\n');
    const native = await reopened.prepare('codex', { env: { CODEX_HOME: path.join(home, '.codex') } });
    assert(native.options.skillsPrompt.startsWith('Keep existing instructions\n\n'));
    assert(native.options.disabledSkillPaths.includes(brainstorm));
    assert(native.options.disabledSkillPaths.includes(newer));
    assert(native.options.disabledSkillPaths.includes(codex));
    pass('Codex preserves instructions and disables all copies including cached older versions');

    for (const agent of ['codex', 'claude', 'grok', 'opencode', 'aider']) {
      const prepared = await reopened.prepare(agent, { env: { OPENCODE_CONFIG_CONTENT: '{"model":"keep/model","instructions":["user.md"]}' } });
      const command = buildCommand(agent, { ...prepared.options, mode: 'resume', sessionId: 'test-session' });
      if (agent === 'codex') assert(command.includes('developer_instructions='));
      if (agent === 'claude') assert(command.includes('--append-system-prompt') && command.includes('--disallowedTools Skill') && !command.includes('--disable-slash-commands'));
      if (agent === 'grok') assert(command.includes('--rules'));
      if (agent === 'opencode') {
        const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(config.model, 'keep/model');
        assert(config.instructions.includes('user.md'));
        assert(config.instructions.includes(reopened.catalogFile));
        assert.equal(config.permission.skill, 'deny');
      }
      if (agent === 'aider') {
        assert.equal(prepared.options.skillReadFiles.length, 1);
        assert(prepared.env.PYTHONPATH.includes('aider-skills'));
        assert(command.includes('--read'));
      }
      assert(!buildCommand(agent === 'aider' ? 'codex' : agent, { ...prepared.options, mode: 'login' }).includes('catalog'));
    }
    pass('all runtime adapters and resume paths; login isolated; Aider avoids loading the entire library');

    const quote = makePlatform({ platform: 'win32', env: {}, homedir: () => 'C:\\Users\\test', exists: () => false }).quote;
    const cmd = buildCommand('grok', { skillsPrompt: "a'b $() `literal`" }, { quote });
    assert(cmd.includes("'a''b $() `literal`'"));
    pass('Windows quotes keep catalog instructions literal');

    {
      // O caminho do catálogo vai entre crases, não em JSON.stringify: aspas
      // duplas no prompt eram o que o PowerShell 5.1 / o shim .cmd partiam, e
      // o JSON ainda dobrava as barras de um caminho do Windows (C:\\Users…).
      const prep = await reopened.prepare('claude', {});
      assert(prep.options.skillsPrompt.includes('read `' + reopened.catalogFile + '` and follow'));
      assert(!prep.options.skillsPrompt.includes(JSON.stringify(reopened.catalogFile)));
      const { nativeArgv } = require('./win-argv-sim');
      const winQuote = makePlatform({ platform: 'win32', env: { USERNAME: 'x' }, homedir: 'C:\\Users\\x', exists: () => false }).quote;
      const winCatalog = 'C:\\Users\\Ana Lima\\.norya\\skills\\catalog.md';
      const winPrompt = prep.options.skillsPrompt.split(reopened.catalogFile).join(winCatalog);
      const { argv } = nativeArgv(buildCommand('claude', { skillsPrompt: winPrompt }, { quote: winQuote, isWin: true }));
      assert.strictEqual(argv[argv.indexOf('--append-system-prompt') + 1], winPrompt, 'o claude recebe o prompt inteiro no Windows');
    }
    pass('skills prompt cites the catalog without double quotes; the Windows CLI receives it intact');

    const entry = (await reopened.list()).skills.find(s => s.name === 'table');
    await Promise.all([reopened.setEnabled(entry.id, false), reopened.list({ force: true }), reopened.setEnabled(entry.id, true)]);
    assert((await reopened.list()).skills.find(s => s.id === entry.id).enabled);
    await assert.rejects(reopened.setEnabled('../../outside', false), /não encontrada/);
    await assert.rejects(reopened.setEnabled(entry.id, 'false'), /inválido/);
    pass('refresh/toggle concurrency serialized; invalid identifiers and states rejected');

    const external = put('external-plugin/skills/external', 'external-skill');
    fs.writeFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'external@local': [{ installPath: path.join(home, 'external-plugin'), version: 'abcdef' }],
      'superpowers@official': [{ installPath: path.join(home, '.claude/plugins/cache/official/superpowers/1.0.0'), version: '1.0.0' }],
    } }));
    data = await reopened.list({ force: true });
    assert(data.skills.some(s => s.name === 'external-skill' && s.path === external));
    assert(data.skills.find(s => s.name === 'brainstorming').sources.some(s => s.path === brainstorm));
    assert(!data.skills.some(s => s.sources.some(src => src.path === newer)));
    pass('installed plugin manifest adds external folders and selects installed version over newer cached copy');

    {
      // cache por arquivo: sem releitura quando nada mudou; invalida em edição/remoção/novo
      const lib2 = new SkillsLibrary({ home, stateDir: path.join(tmp, 'norya2') });
      const reads = [];
      const origRead = fs.promises.readFile;
      fs.promises.readFile = function (f, ...a) { if (String(f).endsWith('SKILL.md')) reads.push(String(f)); return origRead.call(this, f, ...a); };
      try {
        const first = await lib2.list({ force: true });
        assert(reads.length > 0);
        reads.length = 0;
        await lib2.list({ force: true });
        assert.equal(reads.length, 0, 'sem mudança não relê nenhum SKILL.md');
        assert(!lib2.snapshot.skills.some(s => 'body' in s), 'texto da skill não é retido');
        const gk = path.join(home, '.grok/skills/table/SKILL.md');
        fs.writeFileSync(gk, '---\nname: table\ndescription: mudou\n---\n# novo conteúdo maior\n');
        const t = new Date(Date.now() + 5000); fs.utimesSync(gk, t, t);
        const edited = await lib2.list({ force: true });
        assert.deepEqual(reads, [gk], 'só o arquivo alterado é relido');
        assert.equal(edited.skills.find(s => s.name === 'table').description, 'mudou');
        assert.notEqual(edited.skills.find(s => s.name === 'table').id, first.skills.find(s => s.name === 'table').id);
        const added = put('.grok/skills/fresh', 'fresh');
        assert((await lib2.list({ force: true })).skills.some(s => s.name === 'fresh'));
        fs.rmSync(path.dirname(added), { recursive: true });
        assert(!(await lib2.list({ force: true })).skills.some(s => s.name === 'fresh'));
        assert(!lib2.fileCache.has(added), 'arquivo apagado sai do cache');
      } finally { fs.promises.readFile = origRead; }
      pass('per-file cache: no re-read when unchanged, invalidates on edit/add/delete, body never retained');
    }

    fs.writeFileSync(reopened.stateFile, '{broken');
    await assert.rejects(reopened.list({ force: true }), /estado das skills/);
    await assert.rejects(reopened.prepare('grok'), /estado das skills/);
    assert.equal(fs.readFileSync(reopened.stateFile, 'utf8'), '{broken');
    pass('corrupt state fails closed and never silently re-enables skills');
    console.log(`All ${n} skill checks passed`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
