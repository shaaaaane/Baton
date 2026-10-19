import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

let vite, drops, images, state;
const dom = new JSDOM('<div id="content"></div><div id="input-bar"><textarea id="msg-input">Draft</textarea><div id="img-preview-row"></div></div>', { url: 'https://baton.test/', pretendToBeVisual: true });
before(async () => {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  vite = await createTestServer({ root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent', appType: 'custom', server: { middlewareMode: true } });
  drops = await vite.ssrLoadModule('/js/file-drop.js');
  images = await vite.ssrLoadModule('/js/components/image.js');
  ({ state } = await vite.ssrLoadModule('/js/state.js'));
});
after(async () => { await vite?.close(); dom.window.close(); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('native batch binds target before reads, stages multiple files once, rejects folders, suppresses DOM file navigation', async () => {
  const win = dom.window;
  const claim = deferred();
  const released = [], staged = [];
  let current = { entries: [], session: 'first' };
  win.document.elementFromPoint = () => win.document.getElementById('content');
  const app = { appState: { session: 'first', project: { hash: 'p' } }, activeThreadCanSend: true };
  const controller = drops.createFileDropController(win, {
    claim: async token => {
      if (token === 'folder') throw new Error('Compress folders to ZIP');
      await claim.promise;
      return { token, name: token + ' 中文.pdf', identity: token };
    },
    release: token => released.push(token),
  }, {
    syncStagedSession: () => current,
    stageNativeFile: (file, transport, target) => {
      staged.push({ file, target });
      target.entries.push({ native: file });
      return { upload: Promise.resolve() };
    },
  }, app);
  try {
    const payload = { type: 'drop', tokens: ['a', 'a', 'b', 'folder'], position: { x: 20, y: 100 }, width: win.innerWidth };
    const pending = controller.handle(payload);
    current = { entries: [], session: 'second' };
    app.appState.session = 'second';
    claim.resolve();
    await pending;
    await controller.handle(payload);
    assert.deepEqual(staged.map(item => [item.file.token, item.target.session]), [['a', 'first'], ['b', 'first']]);
    assert.equal(current.entries.length, 0);
    assert.deepEqual(released, ['folder']);
    const fileDrop = new win.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(fileDrop, 'dataTransfer', { value: { types: ['Files'] } });
    win.document.dispatchEvent(fileDrop);
    assert.equal(fileDrop.defaultPrevented, true);
    const textDrop = new win.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(textDrop, 'dataTransfer', { value: { types: ['text/plain'] } });
    win.document.dispatchEvent(textDrop);
    assert.equal(textDrop.defaultPrevented, false);
    app.appState.session = null;
    await controller.handle({ ...payload, tokens: ['home-file'] });
    assert.ok(released.includes('home-file'));
    assert.match(win.document.querySelector('.native-file-drop-hint').textContent, /writable/);
    await controller.handle({ type: 'leave' });
    assert.equal(win.document.querySelector('.native-file-drop-hint').hidden, true);
  } finally { controller.dispose(); }
});

test('real attachment staging retains inactive-session upload/progress, retries, cancellation and new-session rekey', async () => {
  const win = dom.window;
  state.appState = { device: 'mac', project: { hash: 'p' }, session: 'first', runtime: 'claude' };
  state.activeThreadId = null;
  state.stagedImages = [];
  const first = images.syncStagedSession();
  const prepared = deferred();
  win.apiPost = async () => prepared.promise;
  let uploads = 0;
  const released = [];
  const transport = {
    release: token => released.push(token),
    upload: async (_token, _prepared, progress) => { uploads++; progress(60); },
  };
  const staged = images.stageNativeFile({ name: '中文 space.pdf', size: 42, token: 'one', image: false }, transport, first);
  assert.equal(state.stagedImages.length, 1);
  assert.equal(staged.entry.uploaded, false);
  state.appState.session = 'second';
  images.syncStagedSession();
  assert.equal(state.stagedImages.length, 0);
  prepared.resolve({ key: 'a'.repeat(32) + '.pdf', url: 'https://example.test/' });
  await staged.upload;
  assert.equal(uploads, 1);
  assert.equal(state.stagedImages.length, 0);
  assert.equal(staged.entry.uploaded, true);
  state.appState.session = 'first';
  images.syncStagedSession();
  assert.equal(state.stagedImages[0], staged.entry);
  assert.equal(win.document.querySelector('.staged-file-name').textContent, '中文 space.pdf');
  assert.deepEqual(released, ['one']);

  let failing = true;
  transport.upload = async () => { if (failing) throw new Error('offline'); };
  const failed = images.stageNativeFile({ name: 'retry.zip', size: 3, token: 'two', image: false }, transport, first);
  await failed.upload;
  assert.equal(failed.entry.error, 'offline');
  assert.equal(failed.entry.uploaded, false);
  failing = false;
  await win.retryStagedFile(1);
  assert.equal(failed.entry.uploaded, true);

  const waiting = deferred();
  win.apiPost = () => waiting.promise;
  const removed = images.stageNativeFile({ name: 'removed.zip', size: 3, token: 'three', image: false }, transport, first);
  win.removeStagedImage(2);
  waiting.resolve({ key: 'b'.repeat(32), url: 'https://example.test/' });
  await removed.upload;
  assert.equal(removed.entry.uploaded, false);
  assert.ok(released.includes('three'));
  state.appState.session = '__new__';
  const fresh = images.syncStagedSession();
  fresh.entries.push({ name: 'keep', uploaded: true });
  state.appState.session = 'adopted';
  state.activeThreadId = 'adopted';
  images.rekeyStagedSession();
  assert.equal(images.syncStagedSession(), fresh);
  assert.equal(state.stagedImages[0].name, 'keep');
  assert.equal(win.document.getElementById('msg-input').value, 'Draft');
});

test('native coordinates account for zoom, and overlays and read-only composers reject the drop', async () => {
  const win = dom.window;
  const released = [];
  let point, node = win.document.getElementById('content');
  const app = { appState: { session: 'one', project: {} }, activeThreadCanSend: true };
  win.document.elementFromPoint = (x, y) => { point = [x, y]; return node; };
  const controller = drops.createFileDropController(win, {
    claim: async () => { throw new Error('should not claim rejected drops'); },
    release: token => released.push(token),
  }, {}, app);
  try {
    await controller.handle({ type: 'over', position: { x: 40, y: 80 }, width: win.innerWidth / 2 });
    assert.deepEqual(point, [80, 160]);
    assert.match(win.document.querySelector('.native-file-drop-hint').textContent, /Release/);
    const dialog = win.document.createElement('dialog');
    dialog.open = true;
    win.document.getElementById('content').append(dialog);
    node = dialog;
    await controller.handle({ type: 'drop', tokens: ['modal'], position: { x: 1, y: 1 } });
    dialog.remove();
    node = win.document.getElementById('content');
    app.activeThreadCanSend = false;
    await controller.handle({ type: 'drop', tokens: ['readonly'], position: { x: 1, y: 1 } });
    assert.deepEqual(released, ['modal', 'readonly']);
  } finally { controller.dispose(); }
});

test('disposal during a native claim releases the file without staging it', async () => {
  const win = dom.window;
  win.document.elementFromPoint = () => win.document.getElementById('content');
  const pending = deferred(), released = [];
  let stages = 0;
  const controller = drops.createFileDropController(win, {
    claim: () => pending.promise,
    release: token => released.push(token),
  }, {
    syncStagedSession: () => ({ entries: [] }),
    stageNativeFile: () => { stages++; },
  }, { appState: { session: 'one', project: {} } });
  const task = controller.handle({ type: 'drop', tokens: ['late'], position: { x: 1, y: 1 } });
  controller.dispose();
  pending.resolve({ token: 'late', identity: 'late' });
  await task;
  assert.equal(stages, 0);
  assert.deepEqual(released, ['late']);
});

test('file identity deduplicates repeated native drops within the same staging target', async () => {
  const win = dom.window;
  win.document.elementFromPoint = () => win.document.getElementById('content');
  const target = { entries: [{ native: { identity: 'same-file' } }] }, released = [];
  const controller = drops.createFileDropController(win, {
    claim: async token => ({ token, identity: 'same-file' }),
    release: token => released.push(token),
  }, {
    syncStagedSession: () => target,
    stageNativeFile: () => assert.fail('duplicate must not be staged'),
  }, { appState: { session: 'one', project: {} } });
  try {
    await controller.handle({ type: 'drop', tokens: ['duplicate'], position: { x: 1, y: 1 } });
    assert.deepEqual(released, ['duplicate']);
  } finally { controller.dispose(); }
});
