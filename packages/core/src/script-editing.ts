/** Validate direct HTTP callers as well as MCP clients, before dispatching to Studio. */
export function scriptEditingPayload(request: Record<string, unknown>, mode: 'preview' | 'edit' | 'create') {
  const requireString = (key: string, allowEmpty = false) => {
    const value = request[key];
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new Error(`${key} must be a ${allowEmpty ? '' : 'nonempty '}string`);
    return value;
  };
  validateScriptRevision(request.expected_revision);
  if (mode === 'create') {
    const parent = requireString('parent');
    const name = requireString('name');
    const source = requireString('source', true);
    const className = requireString('className');
    if (Buffer.byteLength(name) > 100) throw new Error('name exceeds 100 bytes');
    if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('source exceeds 1 MiB');
    if (!['Script', 'LocalScript', 'ModuleScript'].includes(className)) throw new Error('className must be Script, LocalScript or ModuleScript');
    if (request.enabled !== undefined && (typeof request.enabled !== 'boolean' || className === 'ModuleScript')) throw new Error('enabled is only valid as a boolean for Script or LocalScript');
    return { parent, name, source, className, ...(request.enabled !== undefined ? { enabled: request.enabled } : {}) };
  }
  const instancePath = requireString('instancePath');
  if (mode === 'edit') requireString('expected_revision');
  if (!Array.isArray(request.edits) || request.edits.length === 0 || request.edits.length > 128) throw new Error('edits must contain 1 to 128 literal replacements');
  const edits = request.edits.map((edit: unknown) => {
    if (!edit || typeof edit !== 'object') throw new Error('Each edit must be an object');
    const { old_string, new_string, replace_all } = edit as Record<string, unknown>;
    if (typeof old_string !== 'string' || old_string.length === 0 || typeof new_string !== 'string' || old_string === new_string) throw new Error('Each edit needs nonempty old_string and different new_string');
    if (Buffer.byteLength(old_string) > 1024 * 1024 || Buffer.byteLength(new_string) > 1024 * 1024) throw new Error('Edit text exceeds 1 MiB');
    if (replace_all !== undefined && typeof replace_all !== 'boolean') throw new Error('replace_all must be a boolean');
    return { old_string, new_string, ...(replace_all !== undefined ? { replace_all } : {}) };
  });
  return { instancePath, edits, ...(request.expected_revision !== undefined ? { expected_revision: request.expected_revision } : {}) };
}

export function validateScriptRevision(revision: unknown) {
  if (revision !== undefined && (typeof revision !== 'string' || revision.length === 0)) throw new Error('expected_revision must be a nonempty string');
}
