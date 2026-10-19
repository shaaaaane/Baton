// Entry for index.html — first-paint modules only.
// Viewer libs and modules are loaded
// lazily by globals.js -> loadViewerLibs(), triggered after the inline shell renders
// the device list. Diff rendering stays deferred until an Edit is expanded.

import './state.js';
import './api.js';
import './components/skeleton.js';
import '../css/back-button.css';
import '../css/breadcrumb.css';
import '../css/file-icons.css';
import '../css/loading.css';
import '../css/project-files.css';
import '../css/git-status.css';
import '../css/workspace-header.css';
import './globals.js';   // defines window.loadViewerLibs (does NOT download libs yet)
import './app.js';
import './preview-prewarm.js';
import './project/browser.js';
import './scroll-indicator.js';
import '../css/message-quote.css';
import { initMessageQuotes } from './message-quote.js';
import '../css/code-copy.css';
import { initCodeCopy } from './code-copy.js';
import '../css/message-copy.css';
import { initMessageCopy } from './message-copy.js';
import '../css/goal-panel.css';
import { initGoalPanel } from './goal-panel.js';
import '../css/mode-panel.css';
import { initModePanel } from './mode-panel.js';
import '../css/image-save.css';
import { initImageSaveControls } from './components/image-save.js';
import { initSystemBack } from './system-back.js';
import '../css/file-drop.css';
import { initMacosFileDrop } from './file-drop.js';

initMessageQuotes();
initCodeCopy();
initMessageCopy();
initGoalPanel();
initModePanel();
initImageSaveControls();
initSystemBack();
initMacosFileDrop();

// Replay any clicks queued by the inline shell before app.js was ready.
if (Array.isArray(window.__navQueue)) {
  var q = window.__navQueue;
  window.__navQueue = null;
  for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
}

// Preheat viewer libs after 1.5s — yields IPC/main thread to navigation on Tauri.
if (window.__preheatViewer) setTimeout(window.loadViewerLibs, 1500);
