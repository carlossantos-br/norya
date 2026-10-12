/**
 * renderer/agents.js — seletor de agente (qual CLI roda a próxima thread).
 *
 * Script CLÁSSICO (ver renderer/state.js).
 *
 * Antes da Fase 3 não existia escolha: a CLI era consequência do `authMode` do
 * perfil, escondido numa aba de um modal. Aqui ela vira explícita.
 *
 * Regras que importam:
 *   • Só é possível escolher uma CLI INSTALADA. Uma ausente aparece esmaecida,
 *     com o comando de instalação — escolhê-la spawnaria um PTY que morre em
 *     "command not found", e isso não é uma opção, é uma armadilha.
 *   • "Automático" (o padrão) segue o authMode do perfil ativo. É o
 *     comportamento histórico, e continua sendo o certo para quem não quer pensar.
 *   • A escolha vale para os PRÓXIMOS spawns; threads vivas não trocam de CLI.
 */
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const CHAVE = 'norya-agent-id';

  let agentes = [];      // vindo de api.detectAgents()
  let aberto = false;

  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  /** Rótulo do que está selecionado agora. */
  function rotuloAtual() {
    if (!st.selectedAgentId) {
      const acc = (st.accounts || []).find(a => a.num === st.activeProfileNum);
      const auto = agentePorAuthMode(acc && acc.authMode);
      const nome = auto ? (agentes.find(a => a.id === auto) || {}).label || auto : 'Codex';
      return { titulo: 'Automático', sub: nome };
    }
    const a = agentes.find(x => x.id === st.selectedAgentId);
    return { titulo: a ? a.label : st.selectedAgentId, sub: a && a.subscription ? a.subscription : '' };
  }

  /** Espelha agents/registry.js. Some quando a thread guardar o agentId. */
  function agentePorAuthMode(mode) {
    if (mode === 'claude') return 'claude';
    if (mode === 'openrouter') return 'aider';
    if (mode === 'chatgpt' || mode === 'apikey') return 'codex';
    return 'codex';
  }

  function escolher(id) {
    st.selectedAgentId = id;
    if (id) localStorage.setItem(CHAVE, id);
    else localStorage.removeItem(CHAVE);
    fechar();
    render();
  }

  function fechar() { aberto = false; $('agentMenu')?.classList.add('hidden'); }

  function abrir() {
    const menu = $('agentMenu');
    if (!menu) return;
    menu.textContent = '';

    // Se a thread aberta tem agente fixado, o seletor NÃO manda nela. Dizer isso
    // aqui evita a leitura errada de "o seletor diz Claude mas roda Grok".
    const fixado = st.selectedThreadId && st.threadAgents[st.selectedThreadId];
    if (fixado) {
      const a = agentes.find(x => x.id === fixado);
      const nota = el('div', 'agent-note',
        `A thread aberta está fixada em ${a ? a.label : fixado}. A escolha abaixo vale para a próxima.`);
      menu.appendChild(nota);
    }

    const auto = el('button', 'agent-item' + (st.selectedAgentId ? '' : ' is-active'));
    auto.type = 'button';
    auto.appendChild(el('span', 'agent-item-label', 'Automático'));
    auto.appendChild(el('span', 'agent-item-sub', 'segue o perfil ativo'));
    auto.addEventListener('click', () => escolher(null));
    menu.appendChild(auto);

    for (const a of agentes) {
      const item = el('button', 'agent-item'
        + (a.installed ? '' : ' is-missing')
        + (st.selectedAgentId === a.id ? ' is-active' : ''));
      item.type = 'button';
      item.appendChild(el('span', 'agent-item-label', a.label));
      item.appendChild(el('span', 'agent-item-sub', a.installed
        ? (a.subscription || 'pré-pago')
        : 'não instalada'));

      if (a.installed) {
        item.addEventListener('click', () => escolher(a.id));
      } else {
        item.disabled = true;
        if (a.install) {
          const cmd = el('code', 'agent-item-install', a.install);
          cmd.title = 'Rode isto no terminal para instalar';
          item.appendChild(cmd);
        }
      }
      menu.appendChild(item);
    }

    menu.classList.remove('hidden');
    aberto = true;
  }

  function render() {
    const btn = $('agentPickerBtn');
    if (!btn) return;
    const { titulo, sub } = rotuloAtual();
    btn.querySelector('.ap-label').textContent = titulo;
    // Numa linha só: o sub vira "· Codex". Vazio quando não há o que qualificar.
    btn.querySelector('.ap-sub').textContent = sub ? '· ' + sub : '';
    btn.classList.toggle('is-auto', !st.selectedAgentId);
  }

  // Seletor TUI | Chat — vale para os próximos panes (os vivos trocam pelo ⋯).
  function bootPaneUi() {
    const box = $('paneUiToggle');
    if (!box) return;
    const paint = () => box.querySelectorAll('button[data-ui]').forEach(b => {
      const on = b.dataset.ui === st.paneUi;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    box.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-ui]');
      if (!b) return;
      st.paneUi = b.dataset.ui === 'chat' ? 'chat' : 'tui';
      try { localStorage.setItem('norya-pane-ui', st.paneUi); } catch {}
      paint();
    });
    paint();
  }

  async function boot() {
    bootPaneUi();
    const btn = $('agentPickerBtn');
    if (!btn) return;

    btn.addEventListener('click', ev => { ev.stopPropagation(); aberto ? fechar() : abrir(); });
    document.addEventListener('click', () => { if (aberto) fechar(); });
    $('agentMenu')?.addEventListener('click', ev => ev.stopPropagation());

    try { agentes = await api.detectAgents(); } catch (e) { console.warn('detectAgents', e); }

    // Uma escolha persistida pode ter ficado inválida (o usuário desinstalou a
    // CLI). Cair para automático é melhor do que spawnar algo que não existe.
    if (st.selectedAgentId) {
      const a = agentes.find(x => x.id === st.selectedAgentId);
      if (!a || !a.installed) {
        console.warn(`[agents] "${st.selectedAgentId}" não está mais instalada — voltando para automático`);
        escolher(null);
        return;
      }
    }
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
