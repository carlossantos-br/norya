'use strict';
// Verifica parsers/configs das CLIs instaladas. Não envia prompt a um modelo.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const { SkillsLibrary } = require('../agents/skills');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-skills-cli-'));
  const home = path.join(temp, 'home');
  const stateDir = path.join(temp, 'state');
  const skillDir = path.join(home, '.codex/skills/norya-test');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: norya-test\ndescription: Test Norya skill sharing.\n---\nRead before acting.\n');
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
  for (const key of Object.keys(env)) {
    if (/TOKEN|API_KEY|AUTH_SOCKET|OPEN_SOCKET|OPENCODE_CONFIG|NORYA_SKILLS_CATALOG|PYTHONPATH/.test(key)) delete env[key];
  }
  const run = (bin, args, extra = {}) => {
    const r = spawnSync(bin, args, { env: { ...env, ...extra }, cwd: home, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (r.error?.code === 'ENOENT') { console.log(`SKIP ${bin}: not installed`); return null; }
    assert.equal(r.status, 0, `${bin}: ${(r.stderr || r.error || '').toString().slice(-1500)}`);
    return r.stdout;
  };
  try {
    const library = new SkillsLibrary({ home, stateDir });
    const skill = (await library.list()).skills[0];
    await library.setEnabled(skill.id, false);
    const codex = await library.prepare('codex', { env });
    await new Promise((resolve, reject) => {
      const entries = codex.options.disabledSkillPaths.map(p => `{path=${JSON.stringify(p)},enabled=false}`).join(',');
      const proc = spawn('codex', ['-c', 'developer_instructions=' + JSON.stringify(codex.options.skillsPrompt),
        '-c', 'skills.config=[' + entries + ']', 'app-server', '--listen', 'stdio://'], { env, cwd: home });
      let buffer = '', stderr = '', done = false;
      const end = error => { if(done)return;done=true;clearTimeout(timer);proc.kill();error ? reject(error) : resolve(); };
      const timer = setTimeout(() => end(new Error('Codex skills/list timeout: '+stderr.slice(-700))), 20000);
      proc.on('error', e => e.code === 'ENOENT' ? (console.log('SKIP codex: not installed'),end()) : end(e));
      proc.stderr.on('data', data => { stderr += data; });
      proc.on('exit', code => { if(!done)end(new Error('Codex exited '+code+': '+stderr.slice(-1000))); });
      const send = (id, method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      proc.stdout.on('data', data => {
        buffer += data;
        const lines = buffer.split('\n');buffer=lines.pop();
        for(const line of lines) {
          let response;try{response=JSON.parse(line);}catch{continue;}
          if(response.error){end(new Error(JSON.stringify(response.error)));return;}
          if(response.id===1) send(2,'skills/list',{cwds:[home],forceReload:true});
          if(response.id===2) {
            try {
              const rows=response.result.data.flatMap(x=>x.skills);
              const found=rows.find(s=>s.name==='norya-test');
              assert(found,'Codex did not discover test skill');assert.equal(found.enabled,false);
              console.log('PASS Codex real app-server: config parses and disabled native skill is disabled');end();
            }catch(e){end(e);}
          }
        }
      });
      send(1,'initialize',{clientInfo:{name:'norya-skills-smoke',version:'1.0'},capabilities:{experimentalApi:true}});
    });
    const claude = await library.prepare('claude', { env });
    if(run('claude',['--append-system-prompt',claude.options.skillsPrompt,'--system-prompt-snapshot','off','--disallowedTools','Skill','--help'])) console.log('PASS Claude installed CLI accepts shared prompt, resume refresh and skill discovery switch');
    const grok = await library.prepare('grok', { env });
    const inspected=run('grok',['--rules',grok.options.skillsPrompt,'--cwd',home,'inspect','--json']);
    if(inspected) { JSON.parse(inspected);console.log('PASS Grok installed CLI accepts shared rules in isolated config'); }
    const opencode = await library.prepare('opencode', { env });
    const config=run('opencode',['debug','config'],opencode.env);
    if(config) {
      const parsed=JSON.parse(config);
      assert(parsed.instructions.includes(library.catalogFile));assert.equal(parsed.permission.skill,'deny');
      console.log('PASS OpenCode installed CLI resolves catalog instruction and native skill permission');
    }
    const aider = await library.prepare('aider', { env });
    const result=run('aider',['--help'],aider.env);
    if(result) {
      const commands=path.join(temp,'commands.txt');fs.writeFileSync(commands,'/skill norya-test\n');
      const args=['--model','openai/gpt-4o','--no-git','--yes-always','--no-analytics','--no-check-update',
        '--no-show-release-notes','--no-show-model-warnings','--no-check-model-accepts-settings','--load',commands,'--exit'];
      const extra={...aider.env,OPENAI_API_KEY:'norya-local-parser-check'};
      assert(run('aider',args,extra).includes('Skill desabilitada no Norya: norya-test'));
      await library.setEnabled(skill.id,true);
      assert(run('aider',args,extra).includes('Skill carregada: norya-test'));
      console.log('PASS Aider real CLI: /skill rejects disabled instruction and loads it after toggle, without LLM calls');
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(e=>{console.error(e);process.exitCode=1;});
