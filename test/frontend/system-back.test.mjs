import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

async function setup(t, markup = '') {
  const dom = new JSDOM(`<div id="input-bar"><textarea id="msg-input">Keep my draft</textarea></div>${markup}`, {
    url: 'https://test/', pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element, Event: window.Event,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
  });
  const module = await vite.ssrLoadModule('/js/system-back.js');
  const edge = await vite.ssrLoadModule('/js/edge-back.js');
  t.after(async () => { await vite.close(); window.close(); });
  return { ...module, ...edge, window };
}

test('system back closes the latest active layer before navigating and never changes the draft', async t => {
  const ui = await setup(t);
  const calls = [];
  const first = ui.registerEdgeBackLayer({ navigateBack: () => { calls.push('first'); first.deactivate(); } });
  const second = ui.registerEdgeBackLayer({ navigateBack: () => { calls.push('second'); second.deactivate(); } });
  first.activate(); second.activate();
  const navigate = () => { calls.push('navigate'); return true; };
  for (let i = 0; i < 3; i++) assert.equal(ui.handleSystemBack(navigate), true);
  assert.deepEqual(calls, ['second', 'first', 'navigate']);
  assert.equal(document.getElementById('msg-input').value, 'Keep my draft');
});

test('modal cancellation uses its existing close button and keeps the underlying page', async t => {
  const ui = await setup(t, '<div class="modal-overlay"><button class="cancel">Cancel</button></div>');
  let navigations = 0, cancelled = 0;
  const overlay = document.querySelector('.modal-overlay');
  overlay.querySelector('.cancel').onclick = () => { cancelled++; overlay.hidden = true; };
  const navigate = () => { navigations++; return true; };
  assert.equal(ui.handleSystemBack(navigate), true);
  assert.equal(cancelled, 1);
  assert.equal(navigations, 0);
  ui.handleSystemBack(navigate);
  assert.equal(navigations, 1);
});

test('a disabled modal cancellation control consumes Back without dismissing or navigating', async t => {
  const ui = await setup(t, '<div class="modal-overlay"><button class="cancel" disabled>Cancel</button></div>');
  let effects = 0;
  document.querySelector('.modal-overlay').onclick = () => { effects++; };
  assert.equal(ui.handleSystemBack(() => { effects++; return true; }), true);
  assert.equal(effects, 0);
});

test('image preview and thread-selection modals use their own close controls', async t => {
  const ui = await setup(t, '<div class="modal-overlay"><button class="agent-threads-close">Close threads</button></div><div class="img-overlay"><button class="img-overlay-close">Close image</button></div>');
  const calls = [];
  for (const selector of ['.img-overlay-close', '.agent-threads-close']) {
    document.querySelector(selector).onclick = event => { calls.push(selector); event.target.parentElement.hidden = true; };
  }
  ui.handleSystemBack(); ui.handleSystemBack();
  assert.deepEqual(calls, ['.img-overlay-close', '.agent-threads-close']);
});

test('native dialog cancellation respects prevented cancellation and its cleanup handler', async t => {
  const ui = await setup(t, '<dialog open><button>Close</button></dialog>');
  const dialog = document.querySelector('dialog');
  let navigate = 0;
  const prevent = event => event.preventDefault();
  dialog.addEventListener('cancel', prevent);
  assert.equal(ui.handleSystemBack(() => { navigate++; return true; }), true);
  assert.equal(dialog.open, true);
  assert.equal(navigate, 0);
  dialog.removeEventListener('cancel', prevent);
  ui.handleSystemBack();
  assert.equal(dialog.open, false);
});

test('hidden ancestors do not intercept Back; slash commands close before a preview layer', async t => {
  const ui = await setup(t, '<div hidden><div class="modal-overlay"><button class="cancel">Cancel</button></div></div><div id="slash-popup"></div>');
  const calls = [];
  window.closeSlashPopup = () => { calls.push('slash'); document.getElementById('slash-popup').hidden = true; };
  const layer = ui.registerEdgeBackLayer({ navigateBack: () => { calls.push('layer'); layer.deactivate(); } });
  layer.activate();
  ui.handleSystemBack(); ui.handleSystemBack();
  assert.deepEqual(calls, ['slash', 'layer']);
});

test('root returns false for native backgrounding, while page-specific navigation returns true', async t => {
  const ui = await setup(t);
  assert.equal(ui.handleSystemBack(() => false), false);
  let setupBack = 0;
  const dispose = ui.initSystemBack({ navigate: () => { setupBack++; return true; } });
  assert.equal(window.__batonHandleSystemBack(), true);
  assert.equal(setupBack, 1);
  dispose();
  assert.equal(window.__batonHandleSystemBack, undefined);
});

test('disposing an old registration cannot erase a newer page handler', async t => {
  const ui = await setup(t);
  const first = ui.initSystemBack({ navigate: () => true });
  const second = ui.initSystemBack({ navigate: () => false });
  first();
  assert.equal(window.__batonHandleSystemBack(), false);
  second();
  assert.equal(window.__batonHandleSystemBack, undefined);
});
