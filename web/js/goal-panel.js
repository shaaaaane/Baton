import { state } from './state.js';
import { requestWsRpc } from './ws-rpc.js';
import { registerEdgeBackLayer } from './edge-back.js';

const commandName = '__baton_goal_v1';

export function goalUsage(goal) {
  const seconds = goal?.timeUsedSeconds;
  const elapsed = Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s` : 'Not reported';
  const tokens = Number.isFinite(goal?.tokensUsed) ? goal.tokensUsed.toLocaleString() : 'Not reported';
  return `Execution time: ${elapsed} · Tokens: ${tokens}`
    + (Number.isFinite(goal?.tokenBudget) ? ` / ${goal.tokenBudget.toLocaleString()}` : '');
}

function context() {
  return {
    server: state.SERVER, device: state.appState.device || '',
    projectHash: state.appState.project?.hash || '',
    sessionId: state.activeThreadId || state.appState.session || '',
    runtime: state.appState.runtime,
  };
}

function key(ctx) { return JSON.stringify(ctx); }
function editable(ctx) {
  const input = document.getElementById('msg-input');
  return ctx.runtime === 'codex' && ctx.sessionId.startsWith('codex:')
    && state.activeThreadCanSend !== false && input && !input.disabled
    && !input.readOnly && !input.closest('[inert]');
}

export async function requestGoalControl(ctx, action, objective) {
  const { server, ...route } = ctx;
  const result = await requestWsRpc({
    action: 'list_command_options', commandName, ...route,
    goalAction: action, ...(action === 'set' ? { objective } : {}),
  }, { timeout: 15000 });
  if (result.goalControl?.protocol !== 1) {
    throw new Error('This Bridge does not support Goal controls. Update the Bridge and try again.');
  }
  if (['device', 'projectHash', 'sessionId', 'runtime'].some(field => result[field] !== ctx[field])
    || (result.goalControl.goal && result.goalControl.goal.threadId !== ctx.sessionId.slice(6))) {
    throw new Error('Goal response belongs to a different conversation. Refresh and try again.');
  }
  return result.goalControl;
}

export function initGoalPanel({ request = requestGoalControl } = {}) {
  let panel = null, trigger = null, route = null, snapshot = null;
  let busy = false, error = '', timer = null, frame = null, generation = 0;
  const back = registerEdgeBackLayer({ navigateBack: () => close() });
  const close = () => {
    generation++;
    clearInterval(timer);
    timer = null;
    panel?.close();
    panel?.remove();
    panel = null;
    busy = false;
    snapshot = null;
    back.deactivate();
  };
  const onKey = event => {
    if (!panel?.open || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  const paint = () => {
    if (!panel) return;
    const goal = snapshot?.goal;
    const status = ({
      active: 'Active', paused: 'Paused', complete: 'Complete', blocked: 'Blocked',
      usageLimited: 'Usage limited', budgetLimited: 'Budget limited',
    })[goal?.status] || goal?.status || 'No goal';
    panel.querySelector('[data-goal-status]').textContent = busy ? 'Refreshing…'
      : error ? 'Status unavailable' : snapshot ? status : 'Loading…';
    panel.querySelector('[data-goal-objective]').textContent = goal?.objective || '';
    panel.querySelector('[data-goal-usage]').textContent = goal ? goalUsage(goal) : '';
    panel.querySelector('[data-goal-error]').textContent = error || snapshot?.executionError || '';
    for (const button of panel.querySelectorAll('[data-goal-action]')) {
      const action = button.dataset.goalAction;
      button.disabled = busy || (action !== 'read' && (!snapshot || !!error || !editable(route)));
      if (action === 'pause') button.disabled ||= goal?.status !== 'active';
      if (action === 'resume') button.disabled ||= !goal || goal.status === 'complete'
        || (goal.status === 'active' && !snapshot?.executionError);
      if (action === 'clear') button.disabled ||= !goal;
      if (action === 'set') {
        const text = panel.querySelector('textarea').value.trim();
        button.disabled ||= !text || Array.from(text).length > 4000;
      }
    }
  };
  const refresh = async (action = 'read') => {
    if (!panel || busy) return;
    if (key(context()) !== key(route)) { close(); return; }
    if (action !== 'read' && !editable(route)) { error = 'This conversation is read-only.'; paint(); return; }
    const current = generation;
    const captured = route;
    const objective = panel.querySelector('textarea').value.trim();
    busy = true;
    error = '';
    paint();
    try {
      const result = await request(captured, action, objective);
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
  };
  const open = () => {
    if (panel || !editable(context())) return;
    route = context();
    snapshot = null;
    error = '';
    generation++;
    panel = document.createElement('dialog');
    panel.className = 'goal-panel';
    panel.setAttribute('aria-label', 'Conversation goal');
    panel.innerHTML = `<header><strong>Goal</strong><button type="button" data-goal-close aria-label="Close Goal">×</button></header>
      <p data-goal-status role="status"></p><p data-goal-objective></p><p data-goal-usage></p>
      <p data-goal-error role="alert"></p>
      <div class="goal-actions"><button type="button" data-goal-action="pause">Pause</button><button type="button" data-goal-action="resume">Resume</button><button type="button" data-goal-action="read">Refresh</button><button type="button" data-goal-action="clear">Clear goal</button></div>
      <label>New objective (up to 4,000 characters)<textarea rows="3" maxlength="8000" placeholder="What should this conversation accomplish?"></textarea></label>
      <p class="goal-hint">A new objective resets usage. Goal uses this conversation’s current mode. Pause prevents further Goal continuation; an in-flight turn may still finish. Use Stop in chat to interrupt it.</p>
      <button type="button" data-goal-action="set">Set goal</button>`;
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    panel.addEventListener('click', event => {
      if (event.target.closest('[data-goal-close]')) close();
      const action = event.target.closest('[data-goal-action]')?.dataset.goalAction;
      if (action) void refresh(action);
    });
    panel.querySelector('textarea').addEventListener('input', paint);
    document.body.append(panel);
    panel.showModal();
    back.activate();
    paint();
    void refresh();
    timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
  };
  const update = () => {
    frame = null;
    const ctx = context();
    if (panel && key(ctx) !== key(route)) close();
    const bar = document.getElementById('input-bar');
    if (!bar) return;
    if (!trigger?.isConnected) {
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'goal-panel-entry';
      trigger.textContent = 'Goal';
      trigger.addEventListener('click', open);
      bar.prepend(trigger);
    }
    trigger.hidden = !editable(ctx);
  };
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
