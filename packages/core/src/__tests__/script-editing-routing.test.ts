import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { getReadOnlyTools } from '../tools/definitions.js';

class TestBridge extends BridgeService {
  protected override notifyPeerRegistered() { /* No managed process registry in this test. */ }
}

test.each([
  ['edit_script', { instancePath: 'game.Main', edits: [{ old_string: 'a', new_string: 'b' }], expected_revision: 'v1' }, '/api/edit-script'],
  ['create_script', { parent: 'game.ServerStorage', name: 'Main', className: 'ModuleScript', source: '' }, '/api/create-script'],
  ['set_script_source', { instancePath: 'game.Main', source: '', expected_revision: 'v1' }, '/api/set-script-source'],
  ['edit_script_lines', { instancePath: 'game.Main', old_string: 'a', new_string: 'b', expected_revision: 'v1' }, '/api/edit-script-lines'],
  ['insert_script_lines', { instancePath: 'game.Main', newContent: 'b', expected_revision: 'v1' }, '/api/insert-script-lines'],
  ['delete_script_lines', { instancePath: 'game.Main', line_range: '1', expected_revision: 'v1' }, '/api/delete-script-lines'],
] as const)('%s routes revisions and operation IDs through the real recovery bridge', async (name, args, endpoint) => {
  const bridge = new TestBridge();
  bridge.registerPeer({ peerId: 'edit', transportPeerId: 'edit', instanceId: 'studio', role: 'edit', placeId: 0, placeName: '' });
  bridge.registerPeer({ peerId: 'other', transportPeerId: 'other', instanceId: 'other-studio', role: 'edit', placeId: 0, placeName: '' });
  const tools = new RobloxStudioTools(bridge);
  const invoke = (overrides = {}) => TOOL_HANDLERS[name](tools, { ...args, instance_id: 'studio', operation_id: 'operation', ...overrides });
  try {
    const pending = invoke();
    const sent = bridge.claimNextRequestForTransport('edit', 'socket');
    expect(sent).toMatchObject({ requestId: 'operation', endpoint });
    expect(sent?.data).toMatchObject('expected_revision' in args ? { expected_revision: 'v1' } : { name: 'Main' });
    bridge.settleTransportResponse('edit', 'operation', { success: true, revision: 'v2' });
    const result = await pending;
    expect(await invoke()).toEqual(result);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    expect(bridge.getRequestStatus('operation')).toMatchObject({ outcome: 'success', state: 'settled' });
    await expect(invoke({ instance_id: 'other-studio' })).rejects.toMatchObject({ code: 'operation_id_collision' });
  } finally {
    bridge.clearAllPendingRequests();
  }
});

test('inspector exposes only the read-only preview from the new tools', () => {
  const names = new Set(getReadOnlyTools().map(tool => tool.name));
  expect(names.has('preview_script_edits')).toBe(true);
  expect(names.has('edit_script')).toBe(false);
  expect(names.has('create_script')).toBe(false);
});
