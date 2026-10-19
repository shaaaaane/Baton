import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

async function setup(t, request) {
  const dom = new JSDOM('<div id="content"></div><div id="input-bar"><textarea id="msg-input">Keep my draft</textarea></div>',
    { url: 'https://test/', pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
  });
  const { state } = await vite.ssrLoadModule('/js/state.js');
  state.SERVER = 'https://test';
  state.appState = { device: 'demo', project: { hash: 'project' }, session: 'codex:one', runtime: 'codex' };
  const module = await vite.ssrLoadModule('/js/goal-panel.js');
  const dispose = module.initGoalPanel({ request });
  t.after(async () => { dispose(); await vite.close(); dom.window.close(); });
  return {
    state, module, window, vite,
    click: name => document.querySelector(`[data-goal-action="${name}"]`).click(),
    open: () => document.querySelector('.goal-panel-entry').click(),
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const goal = { threadId: 'one', objective: '<script>original goal</script>',
  status: 'active', timeUsedSeconds: 125, tokensUsed: 2345, tokenBudget: 8000 };

test('Goal opens with authoritative status, time and usage while preserving the chat draft', async t => {
  const calls = [];
  const ui = await setup(t, async (ctx, action) => {
    calls.push({ ctx, action });
    return { protocol: 1, goal };
  });
  assert.equal(calls.length, 0);
  ui.open(); await tick();
  assert.equal(calls[0].action, 'read');
  assert.equal(document.querySelector('[data-goal-status]').textContent, 'Active');
  assert.match(document.querySelector('[data-goal-usage]').textContent, /2m 5s.*2,345.*8,000/);
  assert.equal(document.querySelector('[data-goal-objective]').textContent, goal.objective);
  assert.equal(document.querySelector('.goal-panel script'), null);
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
  assert.match(ui.module.goalUsage({ timeUsedSeconds: null }), /Not reported/);
});

test('pause and resume update confirmed state, with one request per in-flight action', async t => {
  let resolvePause;
  const calls = [];
  const ui = await setup(t, async (ctx, action) => {
    calls.push(action);
    if (action === 'pause') return new Promise(resolve => { resolvePause = resolve; });
    return { protocol: 1, goal };
  });
  ui.open(); await tick();
  ui.click('pause'); ui.click('pause');
  assert.deepEqual(calls, ['read', 'pause']);
  resolvePause({ protocol: 1, goal: { ...goal, status: 'paused' } });
  await tick();
  assert.equal(document.querySelector('[data-goal-status]').textContent, 'Paused');
  ui.click('resume'); await tick();
  assert.deepEqual(calls, ['read', 'pause', 'resume']);
  assert.equal(document.querySelector('[data-goal-status]').textContent, 'Active');
});

test('changing sessions while a request is pending closes the old panel and ignores its result', async t => {
  let finish;
  const ui = await setup(t, () => new Promise(resolve => { finish = resolve; }));
  ui.open();
  ui.state.appState.session = 'codex:two';
  finish({ protocol: 1, goal });
  await tick();
  assert.equal(document.querySelector('.goal-panel'), null);
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
});

test('an account change discards a pending Goal response even when the route is unchanged', async t => {
  let finish;
  const ui = await setup(t, () => new Promise(resolve => { finish = resolve; }));
  ui.state.KEY = 'first-account';
  ui.open();
  ui.state.KEY = 'second-account';
  finish({ protocol: 1, goal });
  await tick();
  assert.equal(document.querySelector('.goal-panel'), null);
});

test('a new conversation cannot use a stale active thread to open Goal controls', async t => {
  let requests = 0;
  const ui = await setup(t, async () => { requests++; return { protocol: 1, goal }; });
  ui.state.appState.session = '__new__';
  ui.state.activeThreadId = 'codex:old';
  ui.open(); await tick();
  assert.equal(requests, 0);
  assert.equal(document.querySelector('.goal-panel'), null);
});

test('new objectives do not overwrite the composer; read-only state blocks mutations', async t => {
  const calls = [];
  const ui = await setup(t, async (ctx, action, objective) => {
    calls.push({ action, objective });
    return { protocol: 1, goal };
  });
  ui.open(); await tick();
  const input = document.querySelector('.goal-panel textarea');
  input.value = 'Finish the tests';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.click('set'); await tick();
  assert.equal(calls.at(-1).objective, 'Finish the tests');
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
  ui.state.activeThreadCanSend = false;
  ui.click('pause'); await tick();
  assert.equal(calls.length, 2);
  assert.match(document.querySelector('[data-goal-error]').textContent, /read-only/);
});

test('failed actions show unverified status and disable further mutations until refresh', async t => {
  let fail = false;
  const ui = await setup(t, async () => {
    if (fail) throw new Error('Status could not be verified');
    return { protocol: 1, goal };
  });
  ui.open(); await tick(); fail = true;
  ui.click('pause'); await tick();
  assert.equal(document.querySelector('[data-goal-status]').textContent, 'Status unavailable');
  assert.match(document.querySelector('[data-goal-error]').textContent, /could not be verified/);
  assert.equal(document.querySelector('[data-goal-action="pause"]').disabled, true);
  fail = false;
  ui.click('read'); await tick();
  assert.equal(document.querySelector('[data-goal-status]').textContent, 'Active');
});

test('a disconnected active goal exposes manual Resume without automatically resuming', async t => {
  const calls = [];
  const ui = await setup(t, async (ctx, action) => {
    calls.push(action);
    return { protocol: 1, goal, executionError: 'Execution connection closed' };
  });
  ui.open(); await tick();
  assert.deepEqual(calls, ['read']);
  assert.equal(document.querySelector('[data-goal-action="resume"]').disabled, false);
  assert.match(document.querySelector('[data-goal-error]').textContent, /connection closed/);
});

test('Escape closes Goal without reaching the global interrupt shortcut', async t => {
  const ui = await setup(t, async () => ({ protocol: 1, goal }));
  let interrupts = 0;
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) interrupts++;
  });
  ui.open(); await tick();
  document.body.dispatchEvent(new ui.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(document.querySelector('.goal-panel'), null);
  assert.equal(interrupts, 0);
});

test('Goal transport rejects old Bridges and responses with different conversation routing', async t => {
  const ui = await setup(t, async () => ({ protocol: 1, goal: null }));
  const { handleWsRpcMessage } = await ui.vite.ssrLoadModule('/js/ws-rpc.js');
  const ctx = { server: 'https://test', account: 'private', device: 'demo', projectHash: 'project', sessionId: 'codex:one', runtime: 'codex' };
  let payload;
  window.wsSendReliable = value => { payload = value; };
  let pending = ui.module.requestGoalControl(ctx, 'read');
  assert.equal('account' in payload, false);
  handleWsRpcMessage({ ...payload, action: 'command_options', options: [] });
  await assert.rejects(pending, /does not support/);
  pending = ui.module.requestGoalControl(ctx, 'pause');
  handleWsRpcMessage({ ...payload, action: 'command_options', projectHash: 'other', goalControl: { protocol: 1, goal } });
  await assert.rejects(pending, /different conversation/);
});
