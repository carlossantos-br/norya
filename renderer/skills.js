'use strict';

// A biblioteca não depende da conta ou do provider selecionado no compositor.
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('skillsDialog');
  const labels = { codex: 'Codex', claude: 'Claude', grok: 'Grok', opencode: 'OpenCode', aider: 'Aider', shared: 'Compartilhada', gemini: 'Gemini', cursor: 'Cursor' };
  let snapshot = { skills: [], providers: [], warnings: [] };
  let filter = 'all';
  let loading = false;
  let changing = false;
  let loaded = false;
  const expanded = new Set();
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const normalized = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  function error(message = '') {
    $('skillsError').textContent = message;
    $('skillsError').hidden = !message;
  }

  async function toggle(skill, button) {
    if (changing || loading) return;
    changing = true;
    error();
    button.disabled = true;
    $('skillsRefresh').disabled = true;
    try {
      snapshot = await api.setSkillEnabled(skill.id, !skill.enabled);
      $('skillsFeedback').textContent = `${skill.name}: ${skill.enabled ? 'desabilitada' : 'habilitada'} para todos os providers. Abra ou retome a task para aplicar.`;
    } catch (e) { error(`Não foi possível salvar. ${e.message || e}`); }
    finally {
      changing = false;
      $('skillsRefresh').disabled = false;
      render();
      $('skillsList').querySelector(`[data-skill-id="${skill.id}"] .skill-switch`)?.focus();
    }
  }

  function row(skill) {
    const item = el('article', 'universal-skill' + (skill.enabled ? '' : ' is-disabled'));
    item.dataset.skillId = skill.id;
    const body = el('div', 'universal-skill-body');
    const title = el('h3', 'universal-skill-name', skill.name);
    const description = el('p', 'universal-skill-description', skill.description);
    const origins = [...new Set(skill.sources.map(s => s.plugin || labels[s.provider] || s.provider))];
    const details = el('details', 'universal-skill-origins');
    details.open = expanded.has(skill.id);
    details.addEventListener('toggle', () => details.open ? expanded.add(skill.id) : expanded.delete(skill.id));
    details.append(el('summary', '', `Origem: ${origins.join(' · ')}${skill.sources.length > 1 ? ` · ${skill.sources.length} instalações` : ''}`));
    for (const source of skill.sources) {
      const sourceLine = el('div', 'skill-source');
      sourceLine.append(el('span', '', `${labels[source.provider] || source.provider} · ${source.scope}${source.version ? ' · ' + source.version : ''}`));
      sourceLine.append(el('code', '', source.path));
      details.append(sourceLine);
    }
    body.append(title, description, details);
    const control = el('div', 'universal-skill-control');
    const button = el('button', 'skill-switch');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(skill.enabled));
    button.setAttribute('aria-label', `${skill.enabled ? 'Desabilitar' : 'Habilitar'} ${skill.name} para todos os providers`);
    button.disabled = changing || loading;
    button.append(el('span'));
    button.addEventListener('click', () => toggle(skill, button));
    control.append(button, el('span', 'skill-state-label', skill.enabled ? 'Habilitada' : 'Desabilitada'));
    item.append(body, control);
    return item;
  }

  function render() {
    const skills = snapshot.skills;
    const counts = { all: skills.length, enabled: skills.filter(s => s.enabled).length, disabled: skills.filter(s => !s.enabled).length };
    document.querySelectorAll('[data-skill-filter]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.skillFilter === filter));
      button.querySelector('span').textContent = counts[button.dataset.skillFilter];
    });
    const query = normalized($('skillsSearch').value.trim());
    const visible = skills.filter(s => (filter === 'all' || (filter === 'enabled' ? s.enabled : !s.enabled)) &&
      (!query || normalized([s.name, s.description, ...s.sources.flatMap(src => [src.plugin, src.provider, labels[src.provider], src.scope])].join(' ')).includes(query)));
    $('skillsCount').textContent = `${visible.length} ${visible.length === 1 ? 'skill' : 'skills'}`;
    $('skillsProviders').replaceChildren(...snapshot.providers.map(p => el('span', 'skills-provider', labels[p.id] || p.label)));
    const list = $('skillsList');
    list.replaceChildren();
    if (!visible.length) {
      const empty = el('div', 'skills-empty');
      empty.append(el('h3', '', loading ? 'Reunindo suas skills…' : skills.length ? 'Nenhuma skill neste filtro' : loaded ? 'Sua biblioteca está vazia' : 'Carregando biblioteca…'));
      empty.append(el('p', '', skills.length ? 'Experimente outro nome ou selecione Todas.' : 'Skills locais, dos perfis e dos plugins aparecem aqui automaticamente.'));
      list.append(empty);
    } else list.append(...visible.map(row));
    $('skillsWarnings').textContent = snapshot.warnings.join('\n');
    $('skillsWarnings').hidden = !snapshot.warnings.length;
  }

  async function load(force = false) {
    if (loading || changing) return;
    loading = true;
    error();
    $('skillsRefresh').disabled = true;
    $('skillsRefresh').textContent = 'Atualizando…';
    $('skillsList').setAttribute('aria-busy', 'true');
    render();
    try { snapshot = await api.listSkills({ force }); loaded = true; }
    catch (e) { error(`Não foi possível carregar as skills. ${e.message || e}`); }
    finally {
      loading = false;
      $('skillsRefresh').disabled = false;
      $('skillsRefresh').textContent = 'Atualizar';
      $('skillsList').setAttribute('aria-busy', 'false');
      render();
    }
  }

  window.openSkills = () => {
    if (!dialog.open) dialog.showModal();
    $('railSkills').classList.add('active');
    $('skillsSearch').focus();
    load();
  };
  $('railSkills').addEventListener('click', window.openSkills);
  $('skillsClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return; // close event can arrive after a quick reopen
    $('railSkills').classList.remove('active'); $('railSkills').focus();
  });
  $('skillsSearch').addEventListener('input', render);
  $('skillsRefresh').addEventListener('click', () => load(true));
  document.querySelectorAll('[data-skill-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.skillFilter;
    render();
  }));
  ipcRenderer.on('skills-changed', (_, data) => {
    snapshot = data;
    if (dialog.open && !changing && !loading) render();
  });
})();
