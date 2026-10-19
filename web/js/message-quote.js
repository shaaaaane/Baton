import { state } from './state.js';

const selector = '.msg-user, .tl-item.assistant-text';
const quotes = new Map();

function sessionKey() {
  return JSON.stringify([state.SERVER, state.appState.device,
    state.appState.project?.hash, state.appState.session, state.activeThreadId]);
}

function identity(node) {
  const role = node.classList.contains('msg-user') ? 'user:' : 'assistant:';
  if (node.dataset.messageId) return role + 'message:' + node.dataset.messageId;
  if (node.dataset.nativeId) return role + 'native:' + node.dataset.nativeId;
  const turn = node.closest('[data-turn-id]')?.dataset.turnId;
  return turn && node.dataset.blockId
    ? role + 'block:' + JSON.stringify([turn, node.dataset.blockId]) : role;
}

function candidates(container) {
  return [...container.querySelectorAll(selector)]
    .filter(node => !node.closest('.skeleton-copy, .summary-block, .command-panel-tl'));
}

function ownText(node) {
  return node.classList.contains('msg-user')
    ? node.querySelector('.msg-text')?.textContent || ''
    : node.__quoteText ?? node.dataset.quoteText ?? '';
}

export function messageQuoteText(node, container) {
  if (node.classList.contains('msg-user')) return ownText(node);
  const id = identity(node);
  return candidates(container)
    .filter(item => item === node || (id !== 'assistant:' && identity(item) === id))
    .map(ownText)
    .filter(Boolean).join('\n\n');
}

function canQuote(input) {
  return input && !input.disabled && !input.readOnly && !input.closest('[inert]')
    && state.appState.session && state.activeThreadCanSend !== false;
}

function refreshRemoveButton() {
  const input = document.getElementById('msg-input');
  const bar = document.getElementById('input-bar');
  if (!input || !bar) return;
  const quote = quotes.get(sessionKey());
  let remove = bar.querySelector('.remove-message-quote');
  if (!quote || !input.value.startsWith(quote)) {
    remove?.remove();
    return;
  }
  if (!remove) {
    remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-message-quote';
    remove.textContent = 'Remove quote ×';
    bar.prepend(remove);
  }
}

export function refreshMessageQuotes() {
  const container = document.querySelector('.messages');
  if (container) {
    const nodes = candidates(container);
    const last = new Map();
    const hasText = new Set();
    for (const node of nodes) {
      const id = identity(node);
      if (!id.endsWith(':')) last.set(id, node);
      if (ownText(node).trim()) hasText.add(id.endsWith(':') ? node : id);
    }
    for (const node of nodes) {
      const id = identity(node);
      const existing = node.querySelector('.message-quote');
      if ((last.has(id) && last.get(id) !== node) || !hasText.has(id.endsWith(':') ? node : id)) {
        existing?.remove();
        continue;
      }
      if (existing) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-quote';
      button.textContent = 'Quote';
      button.title = 'Quote this message in your draft';
      (node.querySelector('.msg-meta') || node).append(button);
    }
  }
  refreshRemoveButton();
}

export function initMessageQuotes() {
  let frame;
  const schedule = () => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refreshMessageQuotes();
    });
  };
  const click = event => {
    const button = event.target.closest?.('.message-quote, .remove-message-quote');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const input = document.getElementById('msg-input');
    if (!canQuote(input)) return;
    const key = sessionKey();
    const previous = quotes.get(key);
    const draft = previous && input.value.startsWith(previous)
      ? input.value.slice(previous.length) : input.value;
    if (button.classList.contains('remove-message-quote')) {
      if (!previous || !input.value.startsWith(previous)) return;
      input.value = draft;
      quotes.delete(key);
    } else {
      const node = button.closest(selector);
      const text = messageQuoteText(node, node.closest('.messages'));
      if (!text.trim()) return;
      const author = node.classList.contains('msg-user') ? 'You' : 'Assistant';
      const quote = `> ${author}:\n${text.split('\n').map(line => '> ' + line).join('\n')}\n\n`;
      input.value = quote + draft;
      quotes.delete(key);
      quotes.set(key, quote);
      if (quotes.size > 100) quotes.delete(quotes.keys().next().value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
    refreshRemoveButton();
  };
  const pointerdown = event => {
    if (event.target.closest?.('.message-quote, .remove-message-quote')) event.preventDefault();
  };
  document.addEventListener('click', click, true);
  document.addEventListener('pointerdown', pointerdown, true);
  document.addEventListener('input', refreshRemoveButton);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
  return () => {
    observer.disconnect();
    if (frame != null) cancelAnimationFrame(frame);
    document.removeEventListener('click', click, true);
    document.removeEventListener('pointerdown', pointerdown, true);
    document.removeEventListener('input', refreshRemoveButton);
    quotes.clear();
  };
}
