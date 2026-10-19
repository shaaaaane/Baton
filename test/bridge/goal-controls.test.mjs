import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexInteraction } from '../../bridge/codex-interaction.mjs';
import { handleGoalControls, GOAL_CONTROL_COMMAND } from '../../bridge/goal-controls.mjs';

class Client extends EventEmitter {
  generation = 1;
  goal = null;
  stops = 0;
  requests = [];
  failRead = false;
  async start() {}
  async stop() { this.stops++; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/read' || method === 'thread/resume') {
      return { thread: { id: params.threadId, status: { type: 'idle' } } };
    }
    if (method === 'thread/goal/get') {
      if (this.failRead) throw new Error('Goal unavailable');
      return { goal: this.goal };
    }
    if (method === 'thread/goal/set') {
      this.goal = { tokensUsed: 123, timeUsedSeconds: 74, ...this.goal, ...params };
      this.emit('notification', { method: 'thread/goal/updated',
        params: { threadId: params.threadId, goal: this.goal } });
      return { goal: this.goal };
    }
    if (method === 'thread/goal/clear') {
      this.goal = null;
      this.emit('notification', { method: 'thread/goal/cleared', params });
      return {};
    }
    throw new Error('Unexpected request ' + method);
  }
}

function setup(t) {
  const client = new Client();
  const observed = [];
  const codex = new CodexInteraction({ client });
  const base = {
    nativeSessionId: 'test', sessionId: 'codex:test', cwd: '/tmp',
    goalCallbacks: id => { observed.push(id); return {}; },
  };
  t.after(() => codex.shutdown());
  return { client, codex, base, observed };
}

test('viewing Goal reads authoritative usage without resuming or retaining a writer', async t => {
  const { client, codex, base } = setup(t);
  client.goal = { threadId: 'test', objective: 'Do work', status: 'active', tokensUsed: 15, timeUsedSeconds: 9 };
  const result = await codex.controlGoal(base);
  assert.equal(result.goal.timeUsedSeconds, 9);
  assert.equal(result.goal.tokensUsed, 15);
  assert.equal(client.requests.some(r => r.method === 'thread/resume'), false);
  assert.equal(client.stops, 1);
});

test('set, pause, resume and clear use explicit parameters and preserve usage on status changes', async t => {
  const { client, codex, base } = setup(t);
  const call = (goalAction, objective) => codex.controlGoal({ ...base, goalAction, objective });
  assert.equal((await call('set', 'pause')).goal.objective, 'pause', 'objective is not parsed as a command');
  assert.equal(client.stops, 0);
  assert.equal((await call('pause')).goal.status, 'paused');
  assert.equal(client.stops, 1);
  const result = await call('resume');
  assert.equal(result.goal.status, 'active');
  assert.equal(result.goal.timeUsedSeconds, 74);
  assert.equal(result.goal.tokensUsed, 123);
  const writes = client.requests.filter(r => r.method === 'thread/goal/set');
  assert.deepEqual(writes[2].params, { threadId: 'test', status: 'active' });
  assert.equal((await call('clear')).goal, null);
  assert.equal(client.stops, 2);
  assert.equal(client.requests.some(r => r.method === 'turn/start' || r.method === 'turn/interrupt'), false);
});

test('autonomous turns are streamed across multiple continuations and released on completion', async t => {
  const { client, codex, base, observed } = setup(t);
  await codex.controlGoal({ ...base, goalAction: 'set', objective: 'Finish work' });
  for (const id of ['auto-1', 'auto-2']) {
    client.emit('notification', { method: 'turn/started', params: { threadId: 'test', turn: { id, status: 'inProgress' } } });
    client.emit('notification', { method: 'turn/completed', params: { threadId: 'test', turn: { id, status: 'completed' } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(client.stops, 0);
  }
  assert.deepEqual(observed, ['auto-1', 'auto-2']);
  client.emit('notification', { method: 'thread/goal/updated',
    params: { threadId: 'test', goal: { ...client.goal, status: 'complete' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.stops, 1);
});

test('a Goal start arriving before the set response still gets a streaming callback', async t => {
  const { client, codex, base, observed } = setup(t);
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/goal/set') client.emit('notification', {
      method: 'turn/started', params: { threadId: 'test', turn: { id: 'early', status: 'inProgress' } },
    });
    return request(method, params);
  };
  await codex.controlGoal({ ...base, goalAction: 'set', objective: 'Start' });
  assert.deepEqual(observed, ['early']);
});

test('invalid objectives/actions and missing goals fail before mutating or resuming', async t => {
  const { client, codex, base } = setup(t);
  for (const objective of ['', ' ', 'x'.repeat(4001)]) {
    await assert.rejects(codex.controlGoal({ ...base, goalAction: 'set', objective }), /objective/);
  }
  await assert.rejects(codex.controlGoal({ ...base, goalAction: 'delete' }), /Invalid/);
  await assert.rejects(codex.controlGoal({ ...base, goalAction: 'resume' }), /No goal/);
  assert.equal(client.requests.some(r => /resume|set|clear$/.test(r.method)), false);
});

test('unsupported Goal or wrong thread identity never appears as no goal', async t => {
  const { client, codex, base } = setup(t);
  client.failRead = true;
  await assert.rejects(codex.controlGoal(base), /Goal unavailable/);
  client.failRead = false;
  client.goal = { threadId: 'other', status: 'active' };
  await assert.rejects(codex.controlGoal(base), /identity/);
});

test('mutation is not reported successful if its follow-up status read fails', async t => {
  const { client, codex, base } = setup(t);
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'thread/goal/set') client.failRead = true;
    return result;
  };
  await assert.rejects(codex.controlGoal({ ...base, goalAction: 'set', objective: 'Work' }), /could not be verified/);
});

test('unrelated thread notifications cannot change this Goal or create its turns', async t => {
  const { client, codex, base, observed } = setup(t);
  await codex.controlGoal({ ...base, goalAction: 'set', objective: 'Work' });
  client.emit('notification', { method: 'thread/goal/cleared', params: { threadId: 'other' } });
  client.emit('notification', { method: 'turn/started', params: { threadId: 'other', turn: { id: 'foreign' } } });
  assert.deepEqual(observed, []);
  assert.equal(client.stops, 0);
});

test('an execution disconnect is surfaced and reading does not silently restart it', async t => {
  const { client, codex, base } = setup(t);
  await codex.controlGoal({ ...base, goalAction: 'set', objective: 'Work' });
  client.emit('exit', new Error('offline'));
  const before = client.requests.filter(r => r.method === 'thread/resume').length;
  const result = await codex.controlGoal(base);
  assert.match(result.executionError, /connection closed/);
  assert.equal(client.requests.filter(r => r.method === 'thread/resume').length, before);
  assert.equal(client.stops, 1);
});

test('Bridge RPC preserves routing and rejects unsupported runtime/session IDs', async () => {
  const replies = [], calls = [];
  const deps = {
    codex: { controlGoal: async options => { calls.push(options); return { protocol: 1, goal: null }; } },
    cwd: '/tmp', send: response => replies.push(response),
  };
  const message = { commandName: GOAL_CONTROL_COMMAND, requestId: 'r', device: 'd',
    runtime: 'codex', projectHash: 'project', sessionId: 'codex:test' };
  assert.equal(await handleGoalControls({ ...message, commandName: 'model' }, deps), false);
  await handleGoalControls(message, deps);
  assert.equal(replies[0].sessionId, message.sessionId);
  assert.equal(replies[0].projectHash, 'project');
  assert.equal(replies[0].ok, true);
  for (const sessionId of ['__new__', 'codex:', 'codex:../bad']) {
    await handleGoalControls({ ...message, sessionId }, deps);
    assert.equal(replies.at(-1).ok, false);
  }
  await handleGoalControls({ ...message, runtime: 'claude' }, deps);
  assert.equal(replies.at(-1).ok, false);
  assert.equal(calls.length, 1);
});

test('Goal controls never automatically terminate another terminal, even if it is idle', async t => {
  const client = new Client();
  const request = client.request.bind(client);
  let terminations = 0;
  client.request = async (method, params) => {
    if (method === 'thread/resume') throw new Error('thread already has an active writer');
    return request(method, params);
  };
  const codex = new CodexInteraction({
    client, writerController: {
      describe: () => ({ pid: 42, canTerminate: true, status: 'completed' }),
      terminate: async () => { terminations++; },
    },
  });
  t.after(() => codex.shutdown());
  await assert.rejects(codex.controlGoal({
    nativeSessionId: 'test', sessionId: 'codex:test',
    goalAction: 'set', objective: 'Work', goalCallbacks: () => ({}),
  }), /active writer/);
  assert.equal(terminations, 0);
  assert.equal(client.requests.some(r => r.method === 'thread/goal/set'), false);
});

test('pausing a Goal preserves the stream of an in-flight turn until it finishes', async t => {
  const { client, codex, base } = setup(t);
  await codex.controlGoal({ ...base, goalAction: 'set', objective: 'Work' });
  client.emit('notification', { method: 'turn/started',
    params: { threadId: 'test', turn: { id: 'running', status: 'inProgress' } } });
  await codex.controlGoal({ ...base, goalAction: 'pause' });
  assert.equal(client.stops, 0);
  client.emit('notification', { method: 'turn/completed',
    params: { threadId: 'test', turn: { id: 'running', status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(client.stops, 1);
});
