'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
const result = spawnSync('python3', ['-c', `
import importlib.util, json, os, tempfile
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('norya_aider', ${JSON.stringify(path.join(__dirname, '../agents/aider-skills/sitecustomize.py'))})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temp:
    folder=Path(temp);skill=folder/'SKILL.md';skill.write_text('# brainstorm')
    state=folder/'catalog.json';os.environ['NORYA_SKILLS_CATALOG']=str(state)
    data={'skills':[{'name':'brainstorming','path':str(skill),'enabled':True}]}
    state.write_text(json.dumps(data))
    errors=[]
    coder=SimpleNamespace(abs_read_only_fnames={'user-file.md'},io=SimpleNamespace(tool_error=errors.append))
    assert module.sync_skills(coder,'Build a thing')==[]
    assert module.sync_skills(coder,'Use $brainstorming to design this')==['brainstorming']
    assert os.path.realpath(skill) in coder.abs_read_only_fnames
    data['skills'][0]['enabled']=False;state.write_text(json.dumps(data))
    assert module.sync_skills(coder,'$brainstorming')==[]
    assert coder.abs_read_only_fnames=={'user-file.md'}
    assert errors and 'desabilitada' in errors[0]
    data['skills'][0]['enabled']=True;state.write_text(json.dumps(data))
    assert module.sync_skills(coder,explicit='brainstorming')==['brainstorming']
    state.write_text('{broken')
    try: module.sync_skills(coder,'$brainstorming');raise AssertionError('accepted broken state')
    except json.JSONDecodeError: pass
print('PASS Aider: on-demand skill loading, disable removes only managed files, explicit command, corrupt state rejected')
`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (result.error?.code === 'ENOENT') { console.log('SKIP Aider adapter: python3 unavailable'); }
else { process.stdout.write(result.stdout || ''); assert.equal(result.status, 0, result.stderr); }
