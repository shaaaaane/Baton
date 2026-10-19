import { dismissActiveBackLayer } from './edge-back.js';

function visible(element) {
  for (let node = element; node instanceof Element; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === 'none'
      || getComputedStyle(node).visibility === 'hidden') return false;
  }
  return !!element;
}

export function handleSystemBack(navigate = () => window.navigateUp?.() === true) {
  const dialog = [...document.querySelectorAll('dialog[open]')].filter(visible).at(-1);
  if (dialog) {
    const event = new Event('cancel', { cancelable: true });
    if (dialog.dispatchEvent(event)) dialog.close();
    return true;
  }
  const overlay = [...document.querySelectorAll('.modal-overlay, .img-overlay')]
    .filter(visible).at(-1);
  if (overlay) {
    const close = overlay.querySelector('.cancel, .img-overlay-close, .agent-threads-close');
    if (close && !close.disabled) close.click();
    else if (!close) overlay.click();
    return true;
  }
  const popup = document.getElementById('slash-popup');
  if (visible(popup) && typeof window.closeSlashPopup === 'function') {
    window.closeSlashPopup();
    return true;
  }
  if (dismissActiveBackLayer()) return true;
  return navigate() === true;
}

export function initSystemBack({ navigate } = {}) {
  const handler = () => handleSystemBack(navigate);
  window.__batonHandleSystemBack = handler;
  return () => {
    if (window.__batonHandleSystemBack === handler) {
      delete window.__batonHandleSystemBack;
    }
  };
}
