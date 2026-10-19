import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

let vite;
let macos;
before(async () => {
  vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });
  macos = await vite.ssrLoadModule('/js/macos-zoom.js');
});
after(async () => { await vite?.close(); });

function fixture(stored) {
  const dom = new JSDOM('<!doctype html><textarea></textarea><div class="xterm"><textarea></textarea></div>', {
    url: 'https://baton.test/index.html',
  });
  if (stored !== undefined) dom.window.localStorage.setItem('baton-macos-zoom', stored);
  const calls = [];
  const warnings = [];
  dom.window.console.warn = (...args) => warnings.push(args);
  const controller = macos.createZoomController(dom.window, async (command, args) => {
    calls.push([command, args]);
  });
  return { dom, calls, controller, warnings };
}

function key(win, target, key, modifiers = {}) {
  const event = new win.KeyboardEvent('keydown', {
    key, metaKey: true, bubbles: true, cancelable: true, ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
}

test('native Mac gate excludes browser, Windows, Android and iPad desktop user agent', () => {
  const fake = (platform, touch = 0, native = true) => ({
    navigator: { platform, maxTouchPoints: touch },
    __TAURI_INTERNALS__: native ? {} : undefined,
  });
  assert.equal(macos.isNativeMac(fake('MacIntel')), true);
  assert.equal(macos.isNativeMac(fake('MacIntel', 0, false)), false);
  assert.equal(macos.isNativeMac(fake('MacIntel', 5)), false);
  assert.equal(macos.isNativeMac(fake('Linux aarch64', 5)), false);
  assert.equal(macos.isNativeMac(fake('Win32')), false);
});

test('Cmd zoom works in composer and terminal, leaving other editing/control combinations alone', async () => {
  const { dom, calls, controller } = fixture('1.2');
  try {
    const win = dom.window;
    const composer = win.document.querySelector('textarea');
    const terminal = win.document.querySelector('.xterm textarea');
    let terminalKeys = 0;
    terminal.addEventListener('keydown', () => terminalKeys++);
    await controller.settled();
    assert.deepEqual(calls[0], ['macos_set_zoom', { scale: 1.2 }]);
    assert.equal(key(win, composer, '=').defaultPrevented, true);
    assert.equal(key(win, terminal, '+', { shiftKey: true }).defaultPrevented, true);
    assert.equal(key(win, terminal, '-').defaultPrevented, true);
    await controller.settled();
    assert.deepEqual(calls.slice(1).map(([, args]) => args.scale), [1.3, 1.4, 1.3]);
    assert.equal(terminalKeys, 0);
    for (const [character, modifiers] of [
      ['-', { metaKey: false, ctrlKey: true }],
      ['=', { ctrlKey: true }],
      ['=', { altKey: true }],
      ['_', { shiftKey: true }],
      [')', { shiftKey: true }],
      ['0', { isComposing: true }],
      ['c', {}],
      ['-', { metaKey: false }],
    ]) assert.equal(key(win, terminal, character, modifiers).defaultPrevented, false);
    assert.equal(terminalKeys, 8);
    key(win, composer, '0');
    await controller.settled();
    assert.equal(calls.at(-1)[1].scale, 1);
    assert.equal(win.localStorage.getItem('baton-macos-zoom'), '1');
    controller.dispose();
    assert.equal(key(win, composer, '=').defaultPrevented, false);
  } finally { controller.dispose(); dom.window.close(); }
});

test('zoom is bounded and malformed preferences recover; storage updates do not echo writes', async () => {
  assert.equal(macos.normalizeZoom('invalid'), 1);
  assert.equal(macos.normalizeZoom(null), 1);
  assert.equal(macos.normalizeZoom(Infinity), 1);
  const { dom, calls, controller } = fixture('99');
  try {
    await controller.changeZoom('in');
    assert.equal(calls.at(-1)[1].scale, 2);
    for (let i = 0; i < 30; i++) controller.changeZoom('out');
    await controller.settled();
    assert.equal(calls.at(-1)[1].scale, 0.75);
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {
      key: 'baton-macos-zoom', newValue: '1.5',
    }));
    await controller.settled();
    assert.equal(calls.at(-1)[1].scale, 1.5);
    assert.equal(dom.window.localStorage.getItem('baton-macos-zoom'), '0.75');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: null }));
    await controller.settled();
    assert.equal(calls.at(-1)[1].scale, 1);
  } finally { controller.dispose(); dom.window.close(); }
});

test('failed native zoom does not persist success or poison subsequent shortcuts', async () => {
  const dom = new JSDOM('', { url: 'https://baton.test/' });
  const calls = [];
  dom.window.console.warn = () => {};
  const controller = macos.createZoomController(dom.window, async (command, args) => {
    calls.push(args.scale);
    if (calls.length === 2) throw new Error('native failure');
  });
  try {
    await controller.settled();
    await controller.changeZoom('in');
    assert.equal(dom.window.localStorage.getItem('baton-macos-zoom'), null);
    await controller.changeZoom('in');
    assert.deepEqual(calls, [1, 1.1, 1.1]);
    assert.equal(dom.window.localStorage.getItem('baton-macos-zoom'), '1.1');
  } finally { controller.dispose(); dom.window.close(); }
});
