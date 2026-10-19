import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const android = 'Mozilla/5.0 (Linux; Android 15) Mobile';
const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const h = await makeHarness({ userAgent: android });
const input = h.document.getElementById('msg-input');
const sendButton = h.document.getElementById('send-btn');
sendButton.addEventListener('click', h.window.onSendBtnClick);

function prepare(userAgent) {
  Object.defineProperty(h.window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
  resetSession(h, { sessionId: 'codex:composer-enter' });
  const sent = [];
  h.state.ws = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
  input.value = '第一行\n第二行';
  return sent;
}

function pressEnter(options = {}) {
  const event = new h.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, ...options,
  });
  input.dispatchEvent(event);
  return event;
}

test('Android Enter leaves native newline handling and the draft intact', () => {
  const sent = prepare(android);
  for (const options of [{}, { shiftKey: true }]) {
    assert.equal(pressEnter(options).defaultPrevented, false);
    assert.equal(input.value, '第一行\n第二行');
    assert.equal(h.state.pendingSentMessages.length, 0);
  }
  assert.equal(sent.length, 0);
});

test('Android send button submits the complete multiline draft once', () => {
  const sent = prepare(android);
  pressEnter();
  assert.equal(sent.length, 0);
  sendButton.click();
  const messages = sent.filter(message => message.action === 'send_message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '第一行\n第二行');
});

test('desktop Enter still sends the message', () => {
  const sent = prepare(desktop);
  assert.equal(pressEnter().defaultPrevented, true);
  const messages = sent.filter(message => message.action === 'send_message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '第一行\n第二行');
});

test('desktop Shift+Enter still allows a newline without sending', () => {
  const sent = prepare(desktop);
  assert.equal(pressEnter({ shiftKey: true }).defaultPrevented, false);
  assert.equal(input.value, '第一行\n第二行');
  assert.equal(sent.length, 0);
});

test('IME candidate confirmation does not send on Android or desktop', () => {
  for (const userAgent of [android, desktop]) {
    const sent = prepare(userAgent);
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(pressEnter(options).defaultPrevented, false);
      assert.equal(input.value, '第一行\n第二行');
    }
    assert.equal(sent.length, 0);
  }
});
