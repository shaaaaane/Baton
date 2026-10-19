export const MODE_CONTROL_COMMAND = '__baton_mode_v1';

export async function handleModeControls(message, { codex, cwd, send }) {
  if (message.commandName !== MODE_CONTROL_COMMAND) return false;
  const { requestId, device, runtime, sessionId, projectHash } = message;
  const reply = {
    action: 'command_options', commandName: MODE_CONTROL_COMMAND,
    requestId, device, runtime, sessionId, projectHash, options: [],
  };
  try {
    if (runtime !== 'codex' || !/^codex:[a-zA-Z0-9_-]+$/.test(sessionId || '')) {
      throw new Error('Open an existing Codex conversation to change its mode.');
    }
    reply.modeControl = await codex.controlMode({
      nativeSessionId: sessionId.slice(6), sessionId, cwd,
      modeAction: message.modeAction || 'read', mode: message.mode,
    });
    reply.ok = true;
  } catch (error) {
    reply.ok = false;
    reply.error = error.message || String(error);
  }
  send(reply);
  return true;
}
