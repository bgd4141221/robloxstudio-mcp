#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { McpClient, runTest, assert, selectEditInstance, waitForEditPeer } from './lib/mcp-client.mjs';

await runTest('revision-protected script editing', async ({ track }) => {
  const client = track(new McpClient('script-editing'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client);
  const instance = selectEditInstance(await client.callTool('get_connected_instances', {}));
  assert(instance, 'an edit instance is available');
  const instance_id = instance.id;
  const name = `McpEditing_${randomUUID().replaceAll('-', '')}`;
  const parent = `game.ServerScriptService.${name}`;
  const call = (tool, args) => client.callTool(tool, { ...args, instance_id });
  const fail = (tool, args) => client.callToolError(tool, { ...args, instance_id });
  const execute = code => call('execute_luau', { target: 'edit', code });
  const setup = await execute(`local f = Instance.new("Folder"); f.Name = "${name}"; f.Parent = game:GetService("ServerScriptService"); return true`);
  assert(setup.success, 'fixture folder created');
  try {
    const create = { parent, name: 'Main', className: 'ModuleScript', source: 'local x = 1\nreturn x\n', operation_id: randomUUID() };
    const created = await call('create_script', create);
    assert(created.success && created.revision, `script created: ${JSON.stringify(created)}`);
    const replay = await call('create_script', create);
    assert(replay.revision === created.revision, 'operation replay returns retained creation outcome');
    const collision = await fail('create_script', { ...create, operation_id: randomUUID() });
    assert(JSON.stringify(collision).includes('name_collision'), 'creation rejects an existing child');
    const instancePath = created.instancePath;
    const read = await call('get_script_source', { instancePath, line_range: '1' });
    assert(read.revision === created.revision, 'partial read retains full-source revision');
    const edits = [{ old_string: '1', new_string: '2' }, { old_string: 'return x', new_string: 'return x + 1' }];
    const preview = await call('preview_script_edits', { instancePath, edits });
    assert(preview.revision === read.revision && preview.preview.diff.includes('+return x + 1'), 'preview computes combined diff');
    const before = await call('get_script_source', { instancePath });
    assert(before.revision === read.revision, 'preview leaves source unchanged');
    const invalid = await fail('edit_script', { instancePath, expected_revision: preview.revision, edits: [...edits, { old_string: 'absent', new_string: 'x' }] });
    assert(JSON.stringify(invalid).includes('missing_match'), 'later invalid edit rejects whole batch');
    assert((await call('get_script_source', { instancePath })).revision === read.revision, 'failed batch leaves source unchanged');
    const mutation = { instancePath, edits, expected_revision: preview.revision, operation_id: randomUUID() };
    const applied = await call('edit_script', mutation);
    assert(applied.success && applied.revision !== preview.revision, 'batch applies');
    assert((await call('edit_script', mutation)).revision === applied.revision, 'replay does not reapply edits');
    const stale = await fail('set_script_source', { instancePath, source: 'return 0', expected_revision: preview.revision });
    assert(JSON.stringify(stale).includes('revision_conflict'), 'legacy whole-source write respects revisions');
    const after = await call('get_script_source', { instancePath });
    assert(after.source.includes('local x = 2') && after.source.includes('return x + 1'), 'source matches proposed batch');
    const undo = await execute('game:GetService("ChangeHistoryService"):Undo(); return true');
    assert(undo.success, 'one undo succeeds');
    assert((await call('get_script_source', { instancePath })).revision === preview.revision, 'one undo restores entire batch');
    const drafted = await execute(`
local editor = game:GetService("ScriptEditorService")
local script = game.ServerScriptService.${name}.Main
local opened, openError = editor:OpenScriptDocumentAsync(script)
assert(opened, openError)
local document = assert(editor:FindScriptDocument(script))
local count = document:GetLineCount()
local edited, editError = document:EditTextAsync("local x = 1\\nreturn x + 50\\n", 1, 1, count, #document:GetLine(count) + 1)
assert(edited, editError)
game:GetService("ChangeHistoryService"):SetWaypoint("MCP script editing draft fixture")
return true`);
    assert(drafted.success, 'open editor draft prepared');
    const draftRead = await call('get_script_source', { instancePath, line_range: '1' });
    assert(draftRead.revision !== preview.revision, 'change outside the read range changes the revision');
    const draftConflict = await fail('edit_script', { instancePath, edits, expected_revision: preview.revision });
    assert(JSON.stringify(draftConflict).includes('revision_conflict'), 'old revision cannot overwrite the editor draft');
    const draftEdit = await call('edit_script', { instancePath, edits: [{ old_string: '50', new_string: '51' }], expected_revision: draftRead.revision });
    assert(draftEdit.success, 'current revision edits the open document');
    assert((await call('get_script_source', { instancePath })).source.includes('return x + 51'), 'editor draft change is preserved and updated');
    const duplicate = await execute(`local s = Instance.new("ModuleScript"); s.Name = "Main"; s.Parent = game.ServerScriptService.${name}; return true`);
    assert(duplicate.success, 'duplicate sibling fixture created');
    const ambiguous = await fail('preview_script_edits', { instancePath, edits });
    assert(JSON.stringify(ambiguous).includes('ambiguous_path'), 'ambiguous path is rejected');
    const disabled = await call('create_script', { parent, name: 'Disabled', className: 'Script', source: '' });
    assert(disabled.success && disabled.enabled === false, 'runnable script defaults to disabled');
  } finally {
    const cleaned = await execute(`local f = game:GetService("ServerScriptService"):FindFirstChild("${name}"); if f then f:Destroy() end; return true`);
    assert(cleaned.success, 'fixture folder cleaned up');
  }
}).then(ok => process.exit(ok ? 0 : 1));
