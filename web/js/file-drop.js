import { state } from './state.js';

let installed = false;

export function createFileDropController(win, transport, staging, appState = state) {
  const doc = win.document;
  const seen = new Set();
  let disposed = false;
  let hideTimer;
  const hint = doc.createElement('div');
  hint.className = 'native-file-drop-hint';
  hint.setAttribute('role', 'status');
  hint.hidden = true;
  doc.body.appendChild(hint);

  function show(text, temporary = false) {
    win.clearTimeout(hideTimer);
    hint.textContent = text;
    hint.hidden = false;
    if (temporary) hideTimer = win.setTimeout(hide, 5000);
  }
  function hide() { hint.hidden = true; }
  function destination(position, width) {
    const ratio = width > 0 ? win.innerWidth / width : 1 / (win.devicePixelRatio || 1);
    const node = doc.elementFromPoint?.(position?.x * ratio, position?.y * ratio);
    const bar = doc.getElementById('input-bar');
    const input = doc.getElementById('msg-input');
    if (node?.closest('.xterm, .terminal-page, iframe, dialog[open], .modal-overlay, .file-modal, .browser-page, .git-status-page')) return 'This area does not accept chat attachments';
    if (!appState.appState.session || !appState.appState.project || !bar || bar.hidden
      || win.getComputedStyle(bar).display === 'none' || bar.inert
      || input?.disabled || input?.readOnly || appState.activeThreadCanSend === false) return 'Open a writable conversation first';
    if (!node?.closest('#content, #input-bar')) return 'Drop files into the conversation or composer';
    return '';
  }

  async function handle(payload) {
    if (disposed) return;
    if (payload.type === 'leave') { hide(); return; }
    const reason = destination(payload.position, payload.width);
    if (payload.type === 'over') { show(reason || 'Release to add attachments'); return; }
    if (payload.type !== 'drop') return;
    hide();
    const tokens = [...new Set(payload.tokens || [])].filter(token => !seen.has(token));
    if (reason) {
      for (const token of tokens) transport.release(token);
      show(reason, true);
      return;
    }
    // Capture synchronously, before any native read or module/network await.
    const target = staging.syncStagedSession();
    for (const token of tokens) seen.add(token);
    while (seen.size > 512) seen.delete(seen.values().next().value);
    if (payload.overflow) show('Up to 256 files can be staged; drop files in smaller batches', true);
    const uploads = [];
    for (const token of tokens) {
      try {
        if (disposed) { transport.release(token); continue; }
        const file = await transport.claim(token);
        if (disposed) { transport.release(token); continue; }
        // The native grant is unique; duplicate delivery must never re-stage it.
        const duplicate = target.entries.some(entry => entry.native?.identity === file.identity && file.identity);
        if (duplicate) { transport.release(token); continue; }
        const { upload } = staging.stageNativeFile(file, transport, target);
        uploads.push(upload);
      } catch (error) {
        transport.release(token);
        if (!disposed) show(error.message || 'Could not read dropped file', true);
      }
    }
    await Promise.allSettled(uploads);
  }

  function domDrag(event) {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    // Native drag owns file delivery. Never also consume DOM File objects.
    event.preventDefault();
  }
  doc.addEventListener('dragover', domDrag, true);
  doc.addEventListener('drop', domDrag, true);
  win.addEventListener('blur', hide);
  return {
    handle,
    dispose() {
      disposed = true;
      win.clearTimeout(hideTimer);
      doc.removeEventListener('dragover', domDrag, true);
      doc.removeEventListener('drop', domDrag, true);
      win.removeEventListener('blur', hide);
      transport.dispose?.();
      hint.remove();
    },
  };
}

export async function initMacosFileDrop(win = window) {
  if (installed || !(win.__TAURI_INTERNALS__ && /Mac/.test(win.navigator.platform) && win.navigator.maxTouchPoints < 2)) return;
  installed = true;
  const unlisteners = [];
  let controller;
  const progress = new Map();
  const owned = new Set();
  let uploadQueue = Promise.resolve();
  try {
    const [{ invoke }, { getCurrentWebviewWindow }, staging] = await Promise.all([
      import('@tauri-apps/api/core'), import('@tauri-apps/api/webviewWindow'), import('./components/image.js'),
    ]);
    const native = getCurrentWebviewWindow();
    const release = token => {
      owned.delete(token);
      progress.delete(token);
      return invoke('macos_drop_release', { token }).catch(error => win.console.warn('Could not release drop', error));
    };
    const transport = {
      claim: token => {
        owned.add(token);
        return invoke('macos_drop_claim', { token });
      },
      readImage: async token => new win.Blob([await invoke('macos_drop_read_image', { token })]),
      release,
      dispose: () => { for (const token of [...owned]) release(token); },
      async upload(token, prepared, onProgress, signal) {
        if (signal.aborted) throw new Error('Upload cancelled');
        const abort = () => release(token);
        progress.set(token, onProgress);
        signal.addEventListener('abort', abort, { once: true });
        try {
          const task = uploadQueue.then(() => {
            if (signal.aborted) throw new Error('Upload cancelled');
            return invoke('macos_drop_upload', { token,
              urls: [...new Set([prepared.url, prepared.fallbackUrl].filter(Boolean))],
              headers: prepared.headers || {} });
          });
          uploadQueue = task.catch(() => {});
          await task;
        } finally {
          progress.delete(token);
          signal.removeEventListener('abort', abort);
        }
      },
    };
    controller = createFileDropController(win, transport, staging);
    unlisteners.push(await native.listen('macos-file-progress', event => {
      progress.get(event.payload.token)?.(event.payload.progress);
    }));
    unlisteners.push(await native.listen('macos-file-drop', event => {
      controller.handle(event.payload).catch(error => win.console.warn('Could not accept drop', error));
    }));
    win.addEventListener('pagehide', event => {
      if (!event.persisted) {
        controller.dispose();
        for (const unlisten of unlisteners) unlisten();
      }
    });
  } catch (error) {
    controller?.dispose();
    for (const unlisten of unlisteners) unlisten();
    installed = false;
    win.console.warn('Baton native file drop unavailable', error);
  }
}
