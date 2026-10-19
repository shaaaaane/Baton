import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexInteraction } from '../../bridge/codex-interaction.mjs';
import { applyConfirmedMode, readSavedMode } from '../../bridge/codex-mode-state.mjs';
import { handleModeControls, MODE_CONTROL_COMMAND } from '../../bridge/mode-controls.mjs';

class Client extends EventEmitter {
  generation = 1;
  requests = [];
  stops = 0;
  running = false;
  resumed = false;
  supported = true;
  notify = true;
  async start() {}
  async stop() { this.stops++; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read') return { thread: {
      id: this.wrongId || params.threadId, path: this.file,
      status: { type: this.running || (this.runningAfterResume && this.resumed) ? 'active' : 'idle' },
      ...this.readSettings,
    } };
    if (method === 'collaborationMode/list') return { data: this.supported ? [{ mode: 'plan' }, { mode: 'default' }] : [] };
    if (method === 'thread/resume') {
      if (this.resumeError) throw this.resumeError;
      this.resumed = true;
      return { thread: { id: params.threadId }, model: 'existing-model', reasoningEffort: 'high' };
    }
    if (method === 'thread/settings/update') {
      if (this.notify) this.emit('notification', { method: 'thread/settings/updated',
        params: { threadId: params.threadId, threadSettings: { collaborationMode: params.collaborationMode } } });
      return {};
    }
    throw new Error('Unexpected request ' + method);
  }
}

function setup(t) {
  const client = new Client();
  const codex = new CodexInteraction({ client });
  const base = { nativeSessionId: 'test', sessionId: 'codex:test', cwd: '/tmp' };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-mode-'));
  client.file = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(client.file, JSON.stringify({ type: 'turn_context', payload: { collaboration_mode: { mode: 'plan' } } }) + '\n');
  t.after(async () => { await codex.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { client, codex, base, directory };
}

test('read shows saved mode explicitly without resuming or changing the thread', async t => {
  const { client, codex, base } = setup(t);
  assert.deepEqual(await codex.controlMode(base), {
    protocol: 1, mode: 'plan', source: 'saved', supported: true, running: false,
  });
  assert.deepEqual(client.requests.map(r => r.method), ['thread/read', 'collaborationMode/list']);
  assert.equal(client.stops, 1);
  fs.writeFileSync(client.file, 'invalid\n');
  assert.equal((await codex.controlMode(base)).source, 'unknown');
});

test('switching both directions waits for runtime confirmation and preserves model and effort', async t => {
  const { client, codex, base } = setup(t);
  for (const mode of ['plan', 'default']) {
    const result = await codex.controlMode({ ...base, modeAction: 'set', mode });
    assert.equal(result.mode, mode);
    assert.equal(result.source, 'confirmed');
  }
  const writes = client.requests.filter(r => r.method === 'thread/settings/update');
  assert.deepEqual(writes.map(r => r.params.collaborationMode.settings), [
    { model: 'existing-model', reasoning_effort: 'high', developer_instructions: null },
    { model: 'existing-model', reasoning_effort: 'high', developer_instructions: null },
  ]);
  assert.ok(writes.every(r => !('approvalPolicy' in r.params) && !('sandboxPolicy' in r.params)));
  assert.equal(client.requests.some(r => r.method === 'turn/start'), false);
});

test('running turns, including a turn that starts during resume, reject a mode write', async t => {
  const { client, codex, base } = setup(t);
  client.running = true;
  await assert.rejects(codex.controlMode({ ...base, modeAction: 'set', mode: 'default' }), /current turn/);
  assert.equal(client.requests.some(r => r.method === 'thread/resume'), false);
  client.running = false; client.runningAfterResume = true;
  await assert.rejects(codex.controlMode({ ...base, modeAction: 'set', mode: 'default' }), /current turn/);
  assert.equal(client.requests.some(r => r.method === 'thread/settings/update'), false);
});

test('a fresh runtime model and explicit null effort take precedence over previously resumed settings', async t => {
  const { client, codex, base } = setup(t);
  client.readSettings = { model: 'current-model', reasoningEffort: null };
  await codex.controlMode({ ...base, modeAction: 'set', mode: 'plan' });
  const write = client.requests.find(r => r.method === 'thread/settings/update');
  assert.deepEqual(write.params.collaborationMode.settings, {
    model: 'current-model', reasoning_effort: null, developer_instructions: null,
  });
});

test('mode changes never terminate another terminal writer, even when it appears idle', async t => {
  const { client, codex, base } = setup(t);
  client.resumeError = new Error('thread already has an active writer');
  let terminated = false;
  codex.writerController = {
    describe: () => ({ canTerminate: true, pid: 1234, status: 'completed' }),
    terminate: () => { terminated = true; },
  };
  await assert.rejects(codex.controlMode({ ...base, modeAction: 'set', mode: 'default' }));
  assert.equal(terminated, false);
  assert.equal(client.requests.some(r => r.method === 'thread/settings/update'), false);
});

test('unsupported runtimes, wrong identities and invalid modes cannot write settings', async t => {
  const { client, codex, base } = setup(t);
  client.supported = false;
  assert.equal((await codex.controlMode(base)).supported, false);
  await assert.rejects(codex.controlMode({ ...base, modeAction: 'set', mode: 'plan' }), /does not expose/);
  client.wrongId = 'another';
  await assert.rejects(codex.controlMode(base), /identity/);
  await assert.rejects(codex.controlMode({ ...base, modeAction: 'set', mode: 'bypassPermissions' }), /Invalid/);
  assert.equal(client.requests.some(r => r.method === 'thread/settings/update'), false);
});

test('settings acknowledgements without matching notifications are not reported as confirmed', async () => {
  const client = new Client();
  client.notify = false;
  const args = { threadId: 'test', mode: 'plan', model: 'existing-model', effort: 'high' };
  await assert.rejects(applyConfirmedMode(client, args, 10), /could not be confirmed/);
  assert.equal(client.listenerCount('notification'), 0);
  client.request = async () => {
    client.emit('notification', { method: 'thread/settings/updated', params: {
      threadId: 'wrong-thread', threadSettings: { collaborationMode: { mode: 'plan' } },
    } });
    return {};
  };
  await assert.rejects(applyConfirmedMode(client, args, 10), /could not be confirmed/);
  assert.equal(client.listenerCount('notification'), 0);
});

test('saved-mode reader bounds its read, tolerates partial lines, and never invents a default mode', async t => {
  const { client } = setup(t);
  const applied = { payload: { type: 'thread_settings_applied', thread_settings: { collaboration_mode: { mode: 'default' } } } };
  fs.writeFileSync(client.file, 'x'.repeat(600 * 1024) + '\n' + JSON.stringify(applied) + '\npartial');
  assert.equal(readSavedMode(client.file), 'default');
  fs.appendFileSync(client.file, '\n' + JSON.stringify({ type: 'turn_context', payload: {} }) + '\n');
  assert.equal(readSavedMode(client.file), null);
  assert.equal(readSavedMode(client.file + '.missing'), null);
});

test('mode handler preserves response routing and rejects non-Codex or malformed sessions', async () => {
  const sent = [], calls = [];
  const options = { codex: { controlMode: async args => { calls.push(args); return { protocol: 1 }; } }, cwd: '/tmp', send: value => sent.push(value) };
  const message = { commandName: MODE_CONTROL_COMMAND, requestId: 'request', device: 'device', runtime: 'codex', sessionId: 'codex:thread', projectHash: 'project', modeAction: 'set', mode: 'default' };
  assert.equal(await handleModeControls(message, options), true);
  assert.equal(calls[0].nativeSessionId, 'thread');
  for (const key of ['requestId', 'device', 'runtime', 'sessionId', 'projectHash']) assert.equal(sent[0][key], message[key]);
  await handleModeControls({ ...message, runtime: 'claude' }, options);
  await handleModeControls({ ...message, sessionId: '__new__' }, options);
  assert.equal(calls.length, 1);
  assert.equal(sent[1].ok, false);
  assert.equal(sent[2].ok, false);
  assert.equal(await handleModeControls({ commandName: 'model' }, options), false);
});
