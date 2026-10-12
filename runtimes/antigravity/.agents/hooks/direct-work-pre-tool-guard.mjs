import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateDirectWorkToolUse } from '../skills/orchestra/direct-work-tool-policy.mjs';

function workspaceRoot(payload = {}) {
  const candidates = [
    ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
    payload.workspacePath,
    payload.cwd,
    process.cwd(),
  ].filter((value) => typeof value === 'string' && value.trim());
  return resolve(candidates[0] || process.cwd());
}

function main() {
  let payload;
  try {
    const raw = readFileSync(0, 'utf8');
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ decision: 'deny', reason: 'DIRECT_WORK_INVALID_HOOK_PAYLOAD' }));
    return;
  }

  const repoRoot = workspaceRoot(payload);
  const statePath = resolve(repoRoot, '.agents/state/direct-work-active.json');
  if (!existsSync(statePath)) {
    console.log(JSON.stringify({ decision: 'allow' }));
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    console.log(JSON.stringify({ decision: 'deny', reason: 'DIRECT_WORK_STATE_INVALID' }));
    return;
  }

  const toolCall = payload?.toolCall && typeof payload.toolCall === 'object'
    ? payload.toolCall
    : { name: payload?.toolName, args: payload?.toolArgs || payload?.args || {} };
  const result = evaluateDirectWorkToolUse({
    toolName: String(toolCall?.name || ''),
    toolArgs: toolCall?.args || {},
    implementationPacket: state?.implementationPacket,
    actorRole: state?.role || 'IMPLEMENTER',
  });
  console.log(JSON.stringify({ decision: result.allowed ? 'allow' : 'deny', reason: result.reason }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
