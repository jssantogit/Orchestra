const SPAWN_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'manage_subagents']);
const MUTATION_TOOLS = new Set(['write_to_file', 'replace_file_content', 'edit_file', 'create_file']);
const SEARCH_TOOLS = new Set(['grep_search', 'find_by_name']);

function serialized(value) {
  try { return JSON.stringify(value ?? {}).toLowerCase(); } catch { return ''; }
}

function anchorTokens(packet) {
  return (Array.isArray(packet?.anchors) ? packet.anchors : [])
    .flatMap((anchor) => [anchor?.symbol, anchor?.file, anchor?.testHint, anchor?.exactText])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase());
}

function testLikePath(args = {}) {
  const value = args.path ?? args.filePath ?? args.file_path ?? args.target ?? '';
  return typeof value === 'string' && /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|\.(?:test|spec)\./i.test(value);
}

function matchingTestHint(args, packet) {
  const body = serialized(args);
  return (Array.isArray(packet?.anchors) ? packet.anchors : []).some((anchor) => {
    const hint = typeof anchor?.testHint === 'string' ? anchor.testHint.trim().toLowerCase() : '';
    return hint && body.includes(hint);
  });
}

export function evaluateDirectWorkToolUse({ toolName, toolArgs = {}, implementationPacket, actorRole = 'IMPLEMENTER' } = {}) {
  if (!implementationPacket || typeof implementationPacket !== 'object') {
    return Object.freeze({ allowed: true, reason: 'DIRECT_WORK_INACTIVE' });
  }

  if (actorRole === 'QUICK_AUDITOR') {
    if (MUTATION_TOOLS.has(toolName) || SPAWN_TOOLS.has(toolName)) {
      return Object.freeze({ allowed: false, reason: 'QUICK_AUDITOR_READ_ONLY' });
    }
    return Object.freeze({ allowed: true, reason: 'QUICK_AUDIT_READ_ALLOWED' });
  }

  if (SPAWN_TOOLS.has(toolName)) {
    return Object.freeze({ allowed: false, reason: 'DIRECT_WORK_WORKER_SPAWN_FORBIDDEN' });
  }

  if (SEARCH_TOOLS.has(toolName)) {
    if (implementationPacket.permissions?.discovery === 'NONE') {
      return Object.freeze({ allowed: false, reason: 'DIRECT_WORK_DISCOVERY_NONE' });
    }
    const body = serialized(toolArgs);
    const anchored = anchorTokens(implementationPacket).some((token) => body.includes(token));
    return Object.freeze(anchored
      ? { allowed: true, reason: 'DIRECTED_DISCOVERY_ANCHORED' }
      : { allowed: false, reason: 'DIRECTED_DISCOVERY_ANCHOR_REQUIRED' });
  }

  if (toolName === 'run_command') {
    const command = String(toolArgs.command ?? toolArgs.cmd ?? '').toLowerCase();
    if (/\bgit\s+(?:log|show|blame)\b/.test(command)) {
      return Object.freeze({ allowed: false, reason: 'DIRECT_WORK_GIT_ARCHAEOLOGY_FORBIDDEN' });
    }
  }

  if (MUTATION_TOOLS.has(toolName) && testLikePath(toolArgs)) {
    if (implementationPacket.permissions?.tests !== 'MODIFY_AUTHORIZED_TARGETS') {
      return Object.freeze({ allowed: false, reason: 'DIRECT_WORK_TEST_MUTATION_FORBIDDEN' });
    }
    if (!matchingTestHint(toolArgs, implementationPacket)) {
      return Object.freeze({ allowed: false, reason: 'DIRECT_WORK_TEST_TARGET_NOT_AUTHORIZED' });
    }
  }

  return Object.freeze({ allowed: true, reason: 'DIRECT_WORK_TOOL_ALLOWED' });
}
