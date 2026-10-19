import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const android = 'Mozilla/5.0 (Linux; Android 15) Mobile';
const mobileDevices = [
  ['Android', android],
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'],
  ['iPad', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'],
];
const desktopDevices = [
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'],
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'],
];
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
  h.window.updateSendBtn();
  return sent;
}

function pressEnter(options = {}) {
  const event = new h.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, ...options,
  });
  input.dispatchEvent(event);
  return event;
}

for (const [device, userAgent] of mobileDevices) {
  test(`${device} Enter leaves native newline handling and the draft intact`, () => {
    const sent = prepare(userAgent);
    for (const options of [{}, { shiftKey: true }]) {
      assert.equal(pressEnter(options).defaultPrevented, false);
      assert.equal(input.value, '第一行\n第二行');
      assert.equal(h.state.pendingSentMessages.length, 0);
    }
    assert.equal(sent.length, 0);
  });

  test(`${device} send button submits the complete multiline draft once`, () => {
    const sent = prepare(userAgent);
    pressEnter();
    assert.equal(sent.length, 0);
    sendButton.click();
    const messages = sent.filter(message => message.action === 'send_message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, '第一行\n第二行');
  });
}

for (const [device, userAgent] of desktopDevices) {
  test(`${device} desktop Enter still sends the message`, () => {
    const sent = prepare(userAgent);
    assert.equal(pressEnter().defaultPrevented, true);
    const messages = sent.filter(message => message.action === 'send_message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, '第一行\n第二行');
  });

  test(`${device} desktop Shift+Enter still allows a newline without sending`, () => {
    const sent = prepare(userAgent);
    assert.equal(pressEnter({ shiftKey: true }).defaultPrevented, false);
    assert.equal(input.value, '第一行\n第二行');
    assert.equal(sent.length, 0);
  });
}

test('IME candidate confirmation does not send on mobile or desktop', () => {
  for (const [, userAgent] of [...mobileDevices, ...desktopDevices]) {
    const sent = prepare(userAgent);
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(pressEnter(options).defaultPrevented, false);
      assert.equal(input.value, '第一行\n第二行');
    }
    assert.equal(sent.length, 0);
  }
});
