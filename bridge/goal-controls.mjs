export const GOAL_CONTROL_COMMAND = '__baton_goal_v1';

export async function handleGoalControls(message, { codex, cwd, send, goalCallbacks }) {
  if (message.commandName !== GOAL_CONTROL_COMMAND) return false;
  const { requestId, device, runtime, sessionId, projectHash } = message;
  const reply = {
    action: 'command_options', commandName: GOAL_CONTROL_COMMAND,
    requestId, device, runtime, sessionId, projectHash, options: [],
  };
  try {
    if (runtime !== 'codex' || !/^codex:[a-zA-Z0-9_-]+$/.test(sessionId || '')) {
      throw new Error('Open an existing Codex conversation to use Goal.');
    }
    reply.goalControl = await codex.controlGoal({
      nativeSessionId: sessionId.slice(6), sessionId, cwd,
      goalAction: message.goalAction || 'read', objective: message.objective,
      goalCallbacks,
    });
    reply.ok = true;
  } catch (error) {
    reply.ok = false;
    reply.error = error.message || String(error);
  }
  send(reply);
  return true;
}
