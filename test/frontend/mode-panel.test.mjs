import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

async function setup(t, request) {
  const dom = new JSDOM('<div id="input-bar"><textarea id="msg-input">Keep my draft</textarea></div>',
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
  state.SERVER = 'https://test'; state.KEY = 'account-one';
  state.appState = { device: 'demo', project: { hash: 'project' }, session: 'codex:one', runtime: 'codex' };
  const module = await vite.ssrLoadModule('/js/mode-panel.js');
  const dispose = module.initModePanel({ request });
  t.after(async () => { dispose(); await vite.close(); window.close(); });
  return {
    state, module, window, vite,
    click: mode => document.querySelector(`[data-mode="${mode}"]`).click(),
    open: () => document.querySelector('.mode-panel-entry').click(),
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const saved = { protocol: 1, mode: 'plan', source: 'saved', supported: true, running: false };
const status = () => document.querySelector('[data-mode-status]').textContent;

test('opening reads only the last recorded mode and preserves the draft', async t => {
  const calls = [];
  const ui = await setup(t, async (ctx, action) => { calls.push(action); return saved; });
  assert.deepEqual(calls, []);
  ui.open(); await tick();
  assert.deepEqual(calls, ['read']);
  assert.equal(status(), 'Last recorded: Plan');
  assert.equal(document.querySelector('[data-mode="plan"]').getAttribute('aria-pressed'), 'false');
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
});

test('both directions are confirmed only after completion and duplicate clicks cannot submit', async t => {
  const calls = [];
  let finish;
  const ui = await setup(t, async (ctx, action, mode) => {
    calls.push({ action, mode });
    if (action === 'set') return new Promise(resolve => { finish = () => resolve({ ...saved, mode, source: 'confirmed' }); });
    return saved;
  });
  ui.open(); await tick();
  for (const mode of ['default', 'plan']) {
    const before = calls.length;
    ui.click(mode); ui.click(mode);
    assert.equal(calls.length, before + 1);
    assert.equal(document.querySelector('[data-mode="plan"]').disabled, true);
    finish(); await tick();
    assert.equal(status(), `Confirmed: ${mode === 'plan' ? 'Plan' : 'Normal'}`);
    assert.equal(document.querySelector(`[data-mode="${mode}"]`).getAttribute('aria-pressed'), 'true');
  }
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
});

test('unknown modes are never represented as Normal and unsupported runtimes disable writes', async t => {
  let supported = true;
  const ui = await setup(t, async () => ({ ...saved, mode: null, source: 'unknown', supported }));
  ui.open(); await tick();
  assert.equal(status(), 'Mode not reported');
  assert.equal(document.querySelector('[data-mode="default"]').disabled, false);
  supported = false;
  document.querySelector('[data-mode-refresh]').click(); await tick();
  assert.equal(document.querySelector('[data-mode="default"]').disabled, true);
  assert.match(document.querySelector('[data-mode-note]').textContent, /does not expose/);
});

test('failures invalidate displayed status and require a successful refresh before another write', async t => {
  let fail = false;
  const ui = await setup(t, async () => {
    if (fail) throw new Error('Result could not be confirmed');
    return saved;
  });
  ui.open(); await tick();
  fail = true; ui.click('default'); await tick();
  assert.equal(status(), 'Mode unavailable');
  assert.match(document.querySelector('[data-mode-error]').textContent, /could not be confirmed/);
  assert.equal(document.querySelector('[data-mode="plan"]').disabled, true);
  fail = false; document.querySelector('[data-mode-refresh]').click(); await tick();
  assert.equal(status(), 'Last recorded: Plan');
  assert.equal(document.querySelector('[data-mode="plan"]').disabled, false);
});

test('read-only conversations can be inspected but cannot change mode; running turns also block writes', async t => {
  const calls = [];
  let running = false;
  const ui = await setup(t, async (ctx, action) => { calls.push(action); return { ...saved, running }; });
  ui.open(); await tick();
  ui.state.activeThreadCanSend = false;
  ui.click('default'); await tick();
  assert.deepEqual(calls, ['read']);
  assert.match(document.querySelector('[data-mode-error]').textContent, /read-only/);
  document.querySelector('[data-mode-refresh]').click(); await tick();
  assert.deepEqual(calls, ['read', 'read']);
  assert.equal(document.querySelector('[data-mode="plan"]').disabled, true);
  ui.state.activeThreadCanSend = true; running = true;
  document.querySelector('[data-mode-refresh]').click(); await tick();
  assert.equal(document.querySelector('[data-mode="plan"]').disabled, true);
  assert.match(document.querySelector('[data-mode-note]').textContent, /current turn/);
});

test('an account or session change discards the in-flight result', async t => {
  let finish;
  const ui = await setup(t, () => new Promise(resolve => { finish = resolve; }));
  ui.open(); ui.state.KEY = 'account-two'; finish(saved); await tick();
  assert.equal(document.querySelector('.mode-panel'), null);
  ui.open(); ui.state.appState.session = 'codex:two'; finish(saved); await tick();
  assert.equal(document.querySelector('.mode-panel'), null);
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
});

test('a stale active thread cannot expose controls for a new or non-Codex conversation', async t => {
  const calls = [];
  const ui = await setup(t, async () => { calls.push('read'); return saved; });
  ui.state.activeThreadId = 'codex:old';
  ui.state.appState.session = '__new__';
  ui.open(); await tick();
  assert.deepEqual(calls, []);
  assert.equal(document.querySelector('.mode-panel'), null);
  ui.state.appState.session = 'codex:one';
  ui.state.appState.runtime = 'claude';
  ui.open(); await tick();
  assert.deepEqual(calls, []);
});

test('Escape closes the panel before the global interrupt handler', async t => {
  const ui = await setup(t, async () => saved);
  let interrupts = 0;
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) interrupts++;
  });
  ui.open(); await tick();
  document.body.dispatchEvent(new ui.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(document.querySelector('.mode-panel'), null);
  assert.equal(interrupts, 0);
});

test('mode RPC rejects old Bridges and mismatched routes, and excludes account credentials', async t => {
  const ui = await setup(t, async () => saved);
  const { handleWsRpcMessage } = await ui.vite.ssrLoadModule('/js/ws-rpc.js');
  const ctx = { server: 'https://test', account: 'private', device: 'demo', projectHash: 'project', sessionId: 'codex:one', runtime: 'codex' };
  let payload;
  window.wsSendReliable = value => { payload = value; };
  let pending = ui.module.requestModeControl(ctx, 'read');
  assert.equal('account' in payload, false);
  assert.equal('server' in payload, false);
  handleWsRpcMessage({ ...payload, action: 'command_options', options: [] });
  await assert.rejects(pending, /does not support/);
  pending = ui.module.requestModeControl(ctx, 'set', 'default');
  assert.equal(payload.mode, 'default');
  handleWsRpcMessage({ ...payload, action: 'command_options', projectHash: 'other', modeControl: saved });
  await assert.rejects(pending, /another conversation/);
});
