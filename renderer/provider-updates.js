/* Intent: inspect/update the CLIs shared by Norya accounts without leaving tasks.
 * Palette/surfaces/type: existing Norya tokens; purple action, semantic status,
 * modal surface with a quiet border. Compact rows on the existing 4px scale. */
(() => {
  'use strict';
  const ipc = require('electron').ipcRenderer;
  const byId = id => document.getElementById(id);
  const dialog = byId('providerUpdatesDialog');
  const trigger = byId('railUpdates');
  const list = byId('providerUpdatesList');
  const check = byId('providerUpdatesCheck');
  const error = byId('providerUpdatesError');
  let state = { providers: [], checking: false };
  let pending = false;
  const labels = { unchecked: 'Ainda não verificado', checking: 'Verificando…', missing: 'Não instalado', available: 'Atualização disponível', current: 'Atualizado no canal', ahead: 'Mais recente que o canal', unsupported: 'Atualização manual', error: 'Não foi possível verificar', queued: 'Aguardando sessões terminarem', installing: 'Instalando…', validating: 'Validando nova versão…' };
  function el(tag, className, text) {
    const node = document.createElement(tag); node.className = className || '';
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, action, primary = false) {
    const node = el('button', primary ? 'btn-primary' : 'btn-cancel', text);
    node.type = 'button'; node.onclick = action; return node;
  }
  function render() {
    const count = state.providers.filter(p => p.status === 'available').length;
    const badge = byId('providerUpdatesBadge');
    badge.textContent = count; badge.hidden = !count;
    trigger.title = count ? `Atualizações dos providers · ${count} disponível(is)` : 'Atualizações dos providers';
    trigger.setAttribute('aria-label', trigger.title);
    trigger.classList.toggle('is-checking', !!state.checking);
    check.disabled = state.checking || pending;
    check.textContent = state.checking ? 'Verificando…' : 'Buscar atualizações';
    byId('providerUpdatesChecked').textContent = state.checking ? 'Consultando os instaladores…' : state.checkedAt
      ? `Última consulta: ${new Date(state.checkedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Ainda não verificado';
    if (!dialog.open) return;
    const focus = document.activeElement?.dataset?.updateAction;
    list.replaceChildren();
    if (!state.providers.length) list.append(el('p', 'provider-update-message', 'Localizando providers instalados…'));
    for (const p of state.providers) {
      const row = el('section', 'provider-update-row');
      row.dataset.provider = p.id;
      const body = el('div', 'provider-update-body');
      const heading = el('div', 'provider-update-heading');
      heading.append(el('h3', '', p.label), el('span', `provider-update-status status-${p.job || p.status}`, labels[p.job || p.status]));
      body.append(heading);
      if (p.current) body.append(el('p', 'provider-update-version', `Instalado: ${p.current}${p.latest ? ` · Disponível (${p.channel || 'canal atual'}): ${p.latest}` : ''}`));
      if (p.origin) body.append(el('p', 'provider-update-meta', `${p.origin}${p.channel ? ` · ${p.channel}` : ''}${p.sessions ? ` · ${p.sessions} sessão(ões) aberta(s)` : ''}`));
      if (p.sessions) body.append(el('p', 'provider-update-meta', 'Sessões abertas mantêm a versão com que iniciaram. Reabra a task para usar a versão instalada.'));
      if (p.path) { const location = el('details', 'provider-update-location'); location.append(el('summary', '', 'Local da instalação'), el('code', '', p.path)); body.append(location); }
      const message = p.updateError || p.error || p.message;
      if (message) body.append(el('p', 'provider-update-message', message));
      if (p.origin === 'Homebrew') body.append(el('p', 'provider-update-meta', 'Atualize pelo Terminal do computador com o Homebrew.'));
      row.append(body);
      const actions = el('div', 'provider-update-actions');
      if (p.job === 'queued') actions.append(button('Cancelar', () => action('cancel', p.id)));
      else if (p.job) actions.append(el('span', 'provider-update-meta', 'Aguarde…'));
      else if (p.canUpdate && p.status === 'available') actions.append(button(p.sessions ? 'Atualizar quando livre' : 'Atualizar', () => action('install', p.id), true));
      else if (p.manualCommand && p.status === 'available') actions.append(button('Copiar comando', () => { require('electron').clipboard.writeText(p.manualCommand); showMessage('Comando copiado. Execute no Terminal do computador.'); }));
      else if (p.status === 'unsupported' || p.status === 'missing') actions.append(button('Instruções', () => require('electron').shell.openExternal(p.docs)));
      for (const b of actions.querySelectorAll('button')) { b.disabled = pending; b.dataset.updateAction = p.id; }
      row.append(actions); list.append(row);
    }
    if (focus) list.querySelector(`[data-update-action="${focus}"]`)?.focus();
  }
  function showMessage(message) { error.textContent = message || ''; error.hidden = !message; }
  async function refresh(force = false) {
    if (pending) return;
    pending = true; showMessage(''); render();
    try { state = await ipc.invoke('provider-updates-check', force); }
    catch (e) { showMessage(e.message); }
    finally { pending = false; render(); }
  }
  async function action(kind, id) {
    pending = true; showMessage(''); render();
    try { state = await ipc.invoke(`provider-updates-${kind}`, id); }
    catch (e) { showMessage(e.message); }
    finally { pending = false; render(); }
  }
  trigger.onclick = async () => {
    dialog.showModal(); render();
    try { state = await ipc.invoke('provider-updates-status'); render(); } catch (e) { showMessage(e.message); }
    refresh(true);
  };
  check.onclick = () => refresh(true);
  byId('providerUpdatesClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => trigger.focus());
  // Native dialog provides a focus trap and Escape; prevent app shortcuts behind it.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  ipc.on('provider-updates-changed', (_, snapshot) => { state = snapshot; render(); });
  window.addEventListener('focus', () => refresh());
  setTimeout(() => refresh(), 15000); // background checks reuse the 15 minute cache; opening always checks again
})();
