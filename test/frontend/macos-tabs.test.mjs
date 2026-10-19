import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

let vite, tabs;
before(async () => {
  vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'),
    logLevel: 'silent', appType: 'custom', server: { middlewareMode: true },
  });
  tabs = await vite.ssrLoadModule('/js/macos-tabs.js');
});
after(async () => { await vite?.close(); });

function fixture(route = {}, invoke) {
  const dom = new JSDOM('<!doctype html><div class="top-bar"><div id="top-right"></div></div><textarea id="draft">Keep this draft</textarea>', {
    url: 'https://baton.test/index.html', pretendToBeVisual: true,
  });
  const appState = { appState: route }, calls = [], warnings = [];
  dom.window.console.warn = (...args) => warnings.push(args);
  const controller = tabs.createNativeTabsController(dom.window, async (command, args) => {
    calls.push({ command, args });
    return invoke?.(command, args);
  }, appState);
  return { dom, appState, calls, warnings, controller,
    button: () => dom.window.document.querySelector('.macos-new-tab'),
    dispose() { controller.dispose(); dom.window.close(); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('native tab controls do not activate in browsers, Android or desktop-mode iPad', () => {
  const win = (platform, native = true, maxTouchPoints = 0) => ({
    navigator: { platform, maxTouchPoints }, __TAURI_INTERNALS__: native ? {} : undefined,
  });
  assert.equal(tabs.isNativeMac(win('MacIntel')), true);
  for (const other of [win('MacIntel', false), win('Linux aarch64'), win('Win32'), win('MacIntel', true, 5)]) {
    assert.equal(tabs.isNativeMac(other), false);
    assert.equal(tabs.initNativeTabs(other), null);
  }
});

test('tab titles distinguish home, settings, project, fresh and named sessions without control characters', () => {
  assert.equal(tabs.nativeTabTitle(), 'Baton');
  assert.equal(tabs.nativeTabTitle({ session: 'codex:a' }, '/setup.html'), 'Settings — Baton');
  assert.equal(tabs.nativeTabTitle({ project: { name: 'Example' } }), 'Example — Baton');
  assert.equal(tabs.nativeTabTitle({ session: '__new__', project: { name: 'Example' } }), 'New Session — Example — Baton');
  assert.equal(tabs.nativeTabTitle({ session: 'codex:123456789' }), 'Session 12345678 — Baton');
  assert.equal(tabs.nativeTabTitle({ session: 'a', sessionPreview: '中文\n方案\t\0' }), '中文 方案 — Baton');
  const ref = '[Design%20notes.pdf](baton-file:' + 'a'.repeat(32) + '.pdf)';
  assert.equal(tabs.nativeTabTitle({ session: 'a', sessionPreview: ref }), 'Design notes.pdf — Baton');
  assert.equal(Array.from(tabs.nativeTabTitle({ session: 'a', sessionPreview: '🙂'.repeat(250) })).length, 180 + ' — Baton'.length);
});

test('each window reads its own route and serializes title changes without modifying the draft', async () => {
  let resolveTitle;
  const a = fixture({ session: 'a', sessionPreview: 'First' }, command => {
    if (command === 'macos_set_tab_title' && !resolveTitle) return new Promise(resolve => { resolveTitle = resolve; });
  });
  const b = fixture({ session: 'b', sessionPreview: 'Other window' });
  try {
    await tick();
    a.appState.appState.sessionPreview = 'Renamed';
    a.controller.update();
    assert.equal(a.calls.length, 1);
    resolveTitle();
    await a.controller.settled(); await b.controller.settled();
    assert.deepEqual(a.calls.map(call => call.args.title), ['First — Baton', 'Renamed — Baton']);
    assert.deepEqual(b.calls.map(call => call.args.title), ['Other window — Baton']);
    assert.equal(a.dom.window.document.getElementById('draft').value, 'Keep this draft');
  } finally { a.dispose(); b.dispose(); }
});

test('new tab suppresses duplicate clicks, preserves its source draft and allows retry after failure', async () => {
  let reject;
  const f = fixture({}, command => {
    if (command === 'macos_new_tab') return new Promise((_, fail) => { reject = fail; });
  });
  try {
    const button = f.button();
    button.click(); button.click();
    assert.equal(f.calls.filter(call => call.command === 'macos_new_tab').length, 1);
    assert.equal(button.disabled, true);
    reject(Error('Window creation failed')); await tick();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-label'), 'New tab failed. Retry');
    button.click();
    assert.equal(f.calls.filter(call => call.command === 'macos_new_tab').length, 2);
    reject(Error('Retry failed')); await tick();
    assert.equal(f.dom.window.document.getElementById('draft').value, 'Keep this draft');
  } finally { f.dispose(); }
});

test('navigation snapshots retain the live button rather than an inert cloned control', async () => {
  const f = fixture();
  try {
    const button = f.button(), doc = f.dom.window.document;
    const bar = doc.querySelector('.top-bar');
    bar.innerHTML = bar.innerHTML;
    assert.notEqual(doc.querySelector('.macos-new-tab'), button);
    f.controller.update();
    assert.equal(doc.querySelector('.macos-new-tab'), button);
    assert.equal(doc.querySelectorAll('.macos-new-tab').length, 1);
    button.click(); await tick();
    assert.equal(f.calls.filter(call => call.command === 'macos_new_tab').length, 1);
    assert.equal(button.disabled, false);
  } finally { f.dispose(); }
});

test('failed title updates do not repeat on every DOM mutation and later names can recover', async () => {
  let rejectTitle = true;
  const f = fixture({ session: 'a' }, command => {
    if (command === 'macos_set_tab_title' && rejectTitle) throw Error('Native command unavailable');
  });
  try {
    await f.controller.settled();
    for (let i = 0; i < 5; i++) f.controller.update();
    assert.equal(f.calls.length, 1);
    assert.equal(f.warnings.length, 1);
    rejectTitle = false;
    f.appState.appState.sessionPreview = 'Changed name'; f.controller.update();
    await f.controller.settled();
    assert.equal(f.calls.at(-1).args.title, 'Changed name — Baton');
  } finally { f.dispose(); }
});

test('disposing a window cancels queued title writes and ignores pending tab completion', async () => {
  let finishTitle, finishTab;
  const f = fixture({}, command => new Promise(resolve => {
    if (command === 'macos_set_tab_title') finishTitle = resolve;
    else finishTab = resolve;
  }));
  try {
    await tick(); f.button().click();
    f.appState.appState.session = 'next'; f.controller.update();
    f.controller.dispose();
    finishTitle(); finishTab(); await f.controller.settled(); await tick();
    assert.equal(f.calls.filter(call => call.command === 'macos_set_tab_title').length, 1);
    assert.equal(f.dom.window.document.querySelector('.macos-new-tab'), null);
  } finally { f.dispose(); }
});
