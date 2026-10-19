import fs from 'node:fs';

export function readSavedMode(file) {
  if (typeof file !== 'string' || !file.endsWith('.jsonl')) return null;
  let fd;
  try {
    if (!fs.statSync(file).isFile()) return null;
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 512 * 1024));
    fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
    const lines = bytes.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.payload?.type === 'thread_settings_applied' || row.type === 'turn_context') {
        const settings = row.type === 'turn_context' ? row.payload : row.payload.thread_settings;
        const mode = settings?.collaboration_mode?.mode;
        return ['plan', 'default'].includes(mode) ? mode : null;
      }
    }
  } catch {}
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export async function applyConfirmedMode(client, { threadId, model, effort, mode }, timeout = 3000) {
  if (!['plan', 'default'].includes(mode)) throw new Error('Invalid collaboration mode.');
  if (!model) throw new Error('Codex did not report the current model.');
  let confirm, timer;
  const confirmation = new Promise(resolve => { confirm = resolve; });
  const observe = ({ method, params }) => {
    if (method === 'thread/settings/updated' && params?.threadId === threadId) {
      confirm(params.threadSettings);
    }
  };
  client.on('notification', observe);
  try {
    await client.request('thread/settings/update', {
      threadId, collaborationMode: {
        mode, settings: { model, reasoning_effort: effort ?? null, developer_instructions: null },
      },
    });
    const settings = await Promise.race([
      confirmation, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
    ]);
    if (settings?.collaborationMode?.mode !== mode) {
      throw new Error('Mode update was acknowledged, but its result could not be confirmed. Refresh before retrying.');
    }
    return mode;
  } finally {
    clearTimeout(timer);
    client.off('notification', observe);
  }
}
