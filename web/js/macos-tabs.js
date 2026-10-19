import { state } from './state.js';
import { attachmentPreviewText } from './components/attachment.js';

let controller;
export function isNativeMac(win) {
  return !!win.__TAURI_INTERNALS__ && /Mac/.test(win.navigator.platform)
    && (win.navigator.maxTouchPoints || 0) < 2;
}

export function nativeTabTitle(route = {}, pathname = '') {
  if (pathname.endsWith('/setup.html')) return 'Settings — Baton';
  const plain = value => attachmentPreviewText(String(value || ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const shorten = value => Array.from(value).slice(0, 180).join('');
  if (route.session && route.session !== '__new__') {
    const name = plain(route.sessionPreview)
      || 'Session ' + plain(route.session).replace(/^codex:/, '').slice(0, 8);
    return shorten(name) + ' — Baton';
  }
  const project = plain(route.project?.name);
  if (route.session === '__new__') return shorten('New Session' + (project ? ' — ' + project : '')) + ' — Baton';
  return project ? shorten(project) + ' — Baton' : 'Baton';
}

export function createNativeTabsController(win, invoke, appState = state) {
  const doc = win.document;
  let disposed = false, frame = null, pending = false, lastTitle;
  let titles = Promise.resolve();
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'macos-new-tab';
  const reset = () => {
    button.textContent = '+';
    button.title = 'New Tab (⌘T)';
    button.setAttribute('aria-label', 'New Tab');
  };
  reset();
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (pending || disposed) return;
    pending = true;
    button.disabled = true;
    try {
      await invoke('macos_new_tab');
      if (!disposed) reset();
    } catch (error) {
      if (!disposed) {
        button.textContent = '↻';
        button.title = 'Could not open tab: ' + (error?.message || String(error));
        button.setAttribute('aria-label', 'New tab failed. Retry');
      }
    } finally {
      pending = false;
      if (!disposed) button.disabled = false;
    }
  });
  const update = () => {
    frame = null;
    if (disposed) return;
    const target = doc.querySelector('body > .top-bar #top-right');
    // Restoring a navigation snapshot can clone the button without its listener.
    for (const stale of doc.querySelectorAll('.macos-new-tab')) {
      if (stale !== button) stale.remove();
    }
    if (target && button.parentElement !== target) target.prepend(button);
    const title = nativeTabTitle(appState.appState, win.location.pathname);
    if (title === lastTitle) return;
    lastTitle = title;
    titles = titles.then(() => {
      if (!disposed) return invoke('macos_set_tab_title', { title });
    }).catch(error => win.console.warn('Could not update native tab title', error));
  };
  const observer = new win.MutationObserver(() => {
    if (frame == null) frame = win.requestAnimationFrame(update);
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  update();
  return {
    update,
    settled: () => titles,
    dispose() {
      disposed = true;
      observer.disconnect();
      if (frame != null) win.cancelAnimationFrame(frame);
      button.remove();
    },
  };
}

export function initNativeTabs(win = window) {
  if (!isNativeMac(win)) return null;
  if (!controller) {
    const native = import('@tauri-apps/api/core');
    controller = createNativeTabsController(win, (command, args) =>
      native.then(({ invoke }) => invoke(command, args)));
    win.addEventListener('pagehide', event => {
      if (!event.persisted) controller?.dispose();
    });
  }
  return controller;
}
