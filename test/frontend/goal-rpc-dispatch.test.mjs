import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, resetSession } from './harness.mjs';

test('real WebSocket dispatcher settles Goal RPCs and preserves ordinary command pickers', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:one' });
  const { requestWsRpc } = await import('../../web/js/ws-rpc.js');
  let request, picked;
  h.window.wsSendReliable = payload => { request = payload; };
  h.window.handleCommandOptions = payload => { picked = payload; };
  const pending = requestWsRpc({
    action: 'list_command_options', commandName: '__baton_goal_v1', sessionId: 'codex:one',
  }, { timeout: 1000 });
  const reply = { ...request, action: 'command_options', goalControl: { protocol: 1, goal: null } };
  h.hooks.handleWsMessage(reply);
  assert.deepEqual(await pending, reply);
  assert.equal(picked, undefined);
  const regular = { action: 'command_options', requestId: 'ordinary', options: ['model'] };
  h.hooks.handleWsMessage(regular);
  assert.deepEqual(picked, regular);
  h.window.close();
});
