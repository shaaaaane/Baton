import { state } from './state.js';
import { requestWsRpc } from './ws-rpc.js';
import { registerEdgeBackLayer } from './edge-back.js';

const commandName = '__baton_mode_v1';
function context() {
  const session = state.appState.session;
  return {
    server: state.SERVER, account: state.KEY, device: state.appState.device || '',
    projectHash: state.appState.project?.hash || '',
    sessionId: session && session !== '__new__' ? state.activeThreadId || session : session || '',
    runtime: state.appState.runtime,
  };
}
const key = ctx => JSON.stringify(ctx);
const available = ctx => ctx.runtime === 'codex' && ctx.sessionId.startsWith('codex:');
function editable() {
  const input = document.getElementById('msg-input');
  return state.activeThreadCanSend !== false && input && !input.disabled
    && !input.readOnly && !input.closest('[inert]');
}

export async function requestModeControl(ctx, action, mode) {
  const { server, account, ...route } = ctx;
  const result = await requestWsRpc({
    action: 'list_command_options', commandName, ...route, modeAction: action,
    ...(action === 'set' ? { mode } : {}),
  }, { timeout: 20000 });
  if (result.modeControl?.protocol !== 1) {
    throw new Error('This Bridge does not support mode controls. Update the Bridge and try again.');
  }
  if (['device', 'projectHash', 'sessionId', 'runtime'].some(field => result[field] !== ctx[field])) {
    throw new Error('Mode response belongs to another conversation. Refresh and try again.');
  }
  return result.modeControl;
}

export function initModePanel({ request = requestModeControl } = {}) {
  let panel = null, trigger = null, route = null, snapshot = null;
  let busy = false, error = '', frame = null, generation = 0;
  const back = registerEdgeBackLayer({ navigateBack: () => close() });
  function close() {
    generation++;
    panel?.close();
    panel?.remove();
    panel = null;
    snapshot = null;
    busy = false;
    back.deactivate();
  }
  function paint() {
    if (!panel) return;
    const label = ({ plan: 'Plan', default: 'Normal' })[snapshot?.mode];
    panel.querySelector('[data-mode-status]').textContent = busy ? 'Reading mode…'
      : error ? 'Mode unavailable'
      : label ? `${snapshot.source === 'confirmed' ? 'Confirmed' : 'Last recorded'}: ${label}`
      : 'Mode not reported';
    panel.querySelector('[data-mode-note]').textContent = !snapshot ? ''
      : !snapshot.supported ? 'This Codex runtime does not expose Plan/Normal controls.'
      : snapshot.running ? 'Finish or stop the current turn before changing mode.'
      : snapshot.source === 'saved' ? 'Based on the last saved session settings. A mode change will be confirmed by the runtime.'
      : snapshot.source === 'unknown' ? 'No saved mode was found. Choose a mode to set it explicitly.' : '';
    panel.querySelector('[data-mode-error]').textContent = error;
    panel.querySelector('[data-mode-refresh]').disabled = busy;
    for (const button of panel.querySelectorAll('[data-mode]')) {
      button.disabled = busy || !!error || !snapshot?.supported || snapshot.running || !editable();
      button.setAttribute('aria-pressed', String(snapshot?.source === 'confirmed' && snapshot.mode === button.dataset.mode));
    }
  }
  async function refresh(action = 'read', mode) {
    if (!panel || busy) return;
    if (key(context()) !== key(route)) { close(); return; }
    if (action === 'set' && !editable()) { error = 'This conversation is read-only.'; paint(); return; }
    const current = generation, captured = route;
    busy = true;
    error = '';
    paint();
    try {
      const result = await request(captured, action, mode);
      if (current !== generation || key(context()) !== key(captured)) return;
      snapshot = result;
    } catch (cause) {
      if (current !== generation || key(context()) !== key(captured)) return;
      error = cause.message || String(cause);
    } finally {
      if (current === generation) {
        busy = false;
        if (key(context()) !== key(captured)) close();
        else paint();
      }
    }
  }
  function open() {
    if (panel || !available(context())) return;
    route = context();
    snapshot = null;
    error = '';
    generation++;
    panel = document.createElement('dialog');
    panel.className = 'mode-panel';
    panel.setAttribute('aria-label', 'Conversation mode');
    panel.innerHTML = `<header><strong>Conversation mode</strong><button type="button" data-mode-close aria-label="Close mode controls">×</button></header>
      <p data-mode-status role="status"></p><p data-mode-note></p><p data-mode-error role="alert"></p>
      <div class="mode-actions"><button type="button" data-mode="plan">Use Plan</button><button type="button" data-mode="default">Use Normal</button><button type="button" data-mode-refresh>Refresh</button></div>
      <p class="mode-hint">Switch modes without sending a message or changing your draft. Your model, reasoning effort and permissions are preserved.</p>`;
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    panel.addEventListener('click', event => {
      if (event.target.closest('[data-mode-close]')) close();
      if (event.target.closest('[data-mode-refresh]')) void refresh();
      const mode = event.target.closest('[data-mode]')?.dataset.mode;
      if (mode) void refresh('set', mode);
    });
    document.body.append(panel);
    panel.showModal();
    back.activate();
    paint();
    void refresh();
  }
  const onKey = event => {
    if (!panel?.open || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  function update() {
    frame = null;
    const ctx = context();
    if (panel && key(ctx) !== key(route)) close();
    const bar = document.getElementById('input-bar');
    if (!bar) return;
    if (!trigger?.isConnected) {
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'mode-panel-entry';
      trigger.textContent = 'Mode';
      trigger.addEventListener('click', open);
      bar.prepend(trigger);
    }
    trigger.hidden = !available(ctx);
  }
  const observer = new MutationObserver(() => {
    if (frame == null) frame = requestAnimationFrame(update);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  update();
  return () => {
    close();
    observer.disconnect();
    document.removeEventListener('keydown', onKey, true);
    if (frame != null) cancelAnimationFrame(frame);
    trigger?.remove();
  };
}
