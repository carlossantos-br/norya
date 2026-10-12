'use strict';
// Electron real, IPC real, skills fictícias. Não altera perfis nem o app em uso.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norya-skills-ui-'));
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'norya');
  for (const [location, name, description] of [
    ['.claude/plugins/cache/official/superpowers/6.3.0/skills/brainstorming', 'brainstorming', 'Faça perguntas, explore alternativas e valide a proposta antes de implementar.'],
    ['.codex/skills/brainstorming', 'brainstorming', 'Faça perguntas, explore alternativas e valide a proposta antes de implementar.'],
    ['.grok/skills/code-review', 'code-review', 'Revise mudanças e identifique problemas de comportamento.'],
    ['.config/opencode/skills/systematic-debugging', 'systematic-debugging', 'Investigue a causa de um erro com evidências.'],
    ['.aider/skills/writing-plans', 'writing-plans', 'Transforme decisões em um plano de implementação.'],
    ['.codex/skills/pdf', 'pdf', 'Leia, crie e confira documentos PDF com atenção à renderização.'],
  ]) {
    const folder = path.join(home, location); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  }
  const result = spawnSync(require('electron'), [__filename], {
    env: { ...process.env, HOME: os.userInfo().homedir, NORYA_HOME: state,
      NORYA_USER_DATA: path.join(dir, 'userdata'), NORYA_SOCKET_SUFFIX: '-skills-smoke',
      NORYA_SMOKE: '1', NORYA_SKILLS_TEST_HOME: home },
    encoding: 'utf8', timeout: 90000,
  });
  process.stdout.write(result.stdout || '');
  if (result.status) process.stderr.write((result.stderr || '').slice(-6500));
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}
const { app } = require('electron');
const appDir = process.env.NORYA_SMOKE_APP_DIR || path.resolve(__dirname, '..');
app.setAppPath(appDir);
const deadline = setTimeout(() => { console.error('Skills UI smoke timed out'); app.exit(1); }, 75000);
app.on('browser-window-created', (_, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (!win.webContents.getURL().includes('test-window.html')) return;
    try {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const result = await win.webContents.executeJavaScript(`(async () => {
        const waitFor = async fn => { for(let i=0;i<100;i++){if(fn()) return;await new Promise(r=>setTimeout(r,30));}throw new Error('UI wait timed out'); };
        document.getElementById('railSkills').click();
        await waitFor(()=>document.querySelectorAll('.universal-skill').length===5 && document.getElementById('skillsList').getAttribute('aria-busy')==='false');
        const d=document.getElementById('skillsDialog');
        const result={open:d.open,belowBrowser:document.getElementById('railBrowser').nextElementSibling.id==='railSkills',
          removedFromSettings:!document.querySelector('[data-tab="skills"]')&&!document.getElementById('tabSkills'),
          providers:document.querySelectorAll('.skills-provider').length, rows:document.querySelectorAll('.universal-skill').length};
        const search=document.getElementById('skillsSearch');search.value='brainstorming';search.dispatchEvent(new Event('input'));
        result.search=document.querySelectorAll('.universal-skill').length===1;
        result.grouped=document.querySelector('.universal-skill-origins summary').textContent.includes('2 instalações');
        document.querySelector('.skill-switch').click();
        await waitFor(()=>document.querySelector('.skill-switch')?.getAttribute('aria-checked')==='false'&&!document.querySelector('.skill-switch').disabled);
        result.disabled=true;
        document.getElementById('skillsClose').click();result.closed=!d.open;
        document.getElementById('railSkills').click();
        await waitFor(()=>document.getElementById('skillsList').getAttribute('aria-busy')==='false');
        result.persisted=document.querySelector('.skill-switch').getAttribute('aria-checked')==='false';
        search.value='';search.dispatchEvent(new Event('input'));
        document.querySelector('[data-skill-filter="disabled"]').click();
        result.filter=document.querySelectorAll('.universal-skill').length===1;
        document.querySelector('.skill-switch').click();
        await waitFor(()=>document.querySelectorAll('.universal-skill').length===0);
        result.empty=document.querySelector('.skills-empty').textContent.includes('Nenhuma skill neste filtro');
        document.querySelector('[data-skill-filter="all"]').click();
        document.documentElement.dataset.theme='dark';
        result.noOverflow=d.scrollWidth===d.clientWidth&&d.getBoundingClientRect().right<=innerWidth;
        return result;
      })()`);
      assert.deepEqual(result, { open: true, belowBrowser: true, removedFromSettings: true, providers: 5, rows: 5,
        search: true, grouped: true, disabled: true, closed: true, persisted: true, filter: true, empty: true, noOverflow: true });
      console.log('PASS real UI + IPC: sidebar, 5 providers, dedup, search, toggle, persistence, filters, empty state and dark theme');

      const stateFile = path.join(process.env.NORYA_HOME, 'skills/state.json');
      const saved = fs.readFileSync(stateFile, 'utf8');
      fs.writeFileSync(stateFile, '{corrupt');
      await win.webContents.executeJavaScript(`document.getElementById('skillsRefresh').click()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert(await win.webContents.executeJavaScript(`!document.getElementById('skillsError').hidden && !document.getElementById('skillsRefresh').disabled`));
      fs.writeFileSync(stateFile, saved);
      await win.webContents.executeJavaScript(`document.getElementById('skillsRefresh').click()`);
      await new Promise(resolve => setTimeout(resolve, 400));
      assert(await win.webContents.executeJavaScript(`document.getElementById('skillsError').hidden && document.querySelectorAll('.universal-skill').length===5`));
      console.log('PASS corrupt state displayed and retry recovers through real IPC');
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync('/tmp/norya-skills-dark.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`delete document.documentElement.dataset.theme`);
      fs.writeFileSync('/tmp/norya-skills-light.png', (await win.webContents.capturePage()).toPNG());
      win.setSize(570, 720);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert(await win.webContents.executeJavaScript(`document.getElementById('skillsDialog').scrollWidth===document.getElementById('skillsDialog').clientWidth`));
      console.log('PASS narrow viewport fits; screenshots /tmp/norya-skills-{dark,light}.png');
      clearTimeout(deadline); app.exit(0);
    } catch (e) { console.error(e); clearTimeout(deadline); app.exit(1); }
  });
});
require(path.join(appDir, 'main.js'));
