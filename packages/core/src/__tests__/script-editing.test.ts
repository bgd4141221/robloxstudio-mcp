import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { scriptEditingPayload } from '../script-editing.js';

const root = fs.existsSync('studio-plugin') ? process.cwd() : path.resolve('../..');
let bundled: string;
beforeAll(async () => {
  const output = await build({ entryPoints: [path.join(root, 'studio-plugin/src/modules/handlers/ScriptEditingHandlers.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{
    name: 'studio-dependencies', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/(Utils|Recording)$/ }, args => ({ path: args.path.split('/').pop()!, namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: `export default globalThis.${args.path};`, loader: 'js' }));
    },
  }] });
  bundled = output.outputFiles[0].text;
});

function fixture(initial = 'local x = 1\nreturn x\n') {
  let source = initial;
  let playing = false;
  let collision = false;
  let failRead = false;
  const parent = { FindFirstChild: () => collision ? {} : undefined, IsDescendantOf: () => true };
  let script = { Name: 'Main', IsA: (name: string) => name === 'LuaSourceContainer' };
  const writes = jest.fn((_instance: unknown, value: string, expected: string) => {
    if (source !== expected) return { success: false, error: 'concurrent modification' };
    source = value;
    return { success: true };
  });
  const begin = jest.fn((): string | undefined => 'undo');
  const finish = jest.fn();
  const created: { Source: string; Parent: unknown; Enabled: boolean; Destroy: jest.Mock }[] = [];
  let id = 0;
  const context = vm.createContext({
    module: { exports: {} }, Buffer,
    pcall: (callback: () => unknown) => { try { return [true, callback()]; } catch (e) { return [false, String(e)]; } },
    typeIs: (value: unknown, type: string) => type === 'table' ? typeof value === 'object' && value !== null : typeof value === type,
    error: (message: string) => { throw new Error(message); }, tostring: String,
    setmetatable: (value: unknown) => value,
    Enum: { HashAlgorithm: { Blake3: 'hash' } },
    game: { GetService: (service: string) => service === 'RunService' ? { IsRunning: () => playing } : service === 'HttpService' ? { GenerateGUID: () => `id-${++id}` } : { ComputeStringHash: (value: string) => createHash('sha256').update(value).digest('hex') } },
    string: {
      find: (value: string, needle: string, position: number) => { const found = Buffer.from(value).indexOf(Buffer.from(needle), position - 1); return [found < 0 ? undefined : found + 1]; },
      sub: (value: string, start: number, end?: number) => Buffer.from(value).subarray(start - 1, end).toString(),
      byte: (value: string, index: number) => [Buffer.from(value)[index - 1]],
      format: (_format: string, value: number) => value.toString(16).padStart(2, '0'),
    },
    Utils: {
      getInstanceByPathStrict: (value: string) => value === 'parent' ? parent : script,
      getInstancePath: () => 'game.ServerScriptService.Main',
      readScriptSource: (target: unknown) => { if (failRead) throw new Error('read failed'); return target === script ? source : (target as { Source: string }).Source; },
      applyScriptSource: writes,
    },
    Recording: { beginRecording: begin, finishRecording: finish },
    Instance: function(className: string) {
      const item = { Name: '', Source: '', Parent: undefined, Enabled: true, IsA: (name: string) => name === 'BaseScript' && className !== 'ModuleScript', Destroy: jest.fn() };
      created.push(item);
      return item;
    },
  });
  vm.runInContext('String.prototype.size = function() { return Buffer.byteLength(String(this)); }; Array.prototype.size = function() { return this.length; };', context);
  vm.runInContext(bundled, context);
  const call = (method: string, request: object): { success: boolean; error: string; revision: string; replacements: number[]; preview: { diff: string; truncated: boolean } } => vm.runInContext(`module.exports.${method}(${JSON.stringify(request)})`, context);
  const edits = [{ old_string: '1', new_string: '2' }];
  const preview = () => call('previewScriptEdits', { instancePath: 'script', edits });
  return { call, preview, edits, writes, begin, finish, created, source: () => source,
    change: (value: string) => { source = value; }, replace: () => { script = { ...script }; },
    play: () => { playing = true; }, collide: () => { collision = true; }, failRead: () => { failRead = true; } };
}

test('preview and ordered batch agree; apply writes once with the original source and commits one recording', () => {
  const f = fixture();
  const edits = [{ old_string: '1', new_string: '2' }, { old_string: '2', new_string: '3' }];
  const before = f.source();
  const preview = f.call('previewScriptEdits', { instancePath: 'script', edits });
  expect(preview.preview.diff).toBe('-local x = 1\n+local x = 3');
  expect(f.writes).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
  const result = f.call('editScript', { instancePath: 'script', edits, expected_revision: preview.revision });
  expect(result.success).toBe(true); expect(result.revision).not.toBe(preview.revision);
  expect(f.source()).toBe('local x = 3\nreturn x\n');
  expect(f.writes).toHaveBeenCalledTimes(1); expect(f.writes.mock.calls[0][2]).toBe(before);
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.finish).toHaveBeenCalledWith('undo', true);
});

test.each(['missing', 'ambiguous'])('a later %s replacement leaves all source untouched', problem => {
  const f = fixture('x x 1');
  const revision = f.preview().revision;
  const result = f.call('editScript', { instancePath: 'script', expected_revision: revision, edits: [f.edits[0], { old_string: problem === 'missing' ? 'absent' : 'x', new_string: 'y' }] });
  expect(result.error).toContain(`${problem}_match`); expect(f.source()).toBe('x x 1'); expect(f.writes).not.toHaveBeenCalled();
});

test('literal replace_all preserves Unicode, CRLF, punctuation and trailing newline', () => {
  const f = fixture('é.[%] é.[%]\r\n');
  const edits = [{ old_string: 'é.[%]', new_string: '世界$', replace_all: true }];
  const preview = f.call('previewScriptEdits', { instancePath: 'script', edits });
  const result = f.call('editScript', { instancePath: 'script', edits, expected_revision: preview.revision });
  expect(result.replacements).toEqual([2]); expect(f.source()).toBe('世界$ 世界$\r\n');
});

test.each(['changed', 'replaced'])('revision rejects a %s script', kind => {
  const f = fixture(); const revision = f.preview().revision;
  if (kind === 'changed') f.change('1 outside edit'); else f.replace();
  const result = f.call('editScript', { instancePath: 'script', edits: f.edits, expected_revision: revision });
  expect(result.error).toContain('revision_conflict'); expect(f.writes).not.toHaveBeenCalled();
});

test('missing revision, play mode and unavailable recording never write', () => {
  const f = fixture(); const request = { instancePath: 'script', edits: f.edits, expected_revision: f.preview().revision };
  expect(f.call('editScript', { ...request, expected_revision: undefined }).error).toContain('expected_revision');
  f.begin.mockReturnValue(undefined);
  expect(f.call('editScript', request).error).toContain('recording_unavailable');
  f.play(); expect(f.call('editScript', request).error).toContain('edit_mode_required'); expect(f.writes).not.toHaveBeenCalled();
});

test('preview caps output and replacement expansion is bounded before write', () => {
  const f = fixture('x\n'.repeat(1000));
  const preview = f.call('previewScriptEdits', { instancePath: 'script', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] });
  expect(preview.preview.truncated).toBe(true); expect(preview.preview.diff.split('\n').length).toBeLessThanOrEqual(120);
  const result = f.call('editScript', { instancePath: 'script', expected_revision: preview.revision, edits: [{ old_string: 'x', new_string: 'y'.repeat(2000), replace_all: true }] });
  expect(result.error).toContain('source_too_large'); expect(f.writes).not.toHaveBeenCalled();
});

test.each(['Script', 'LocalScript', 'ModuleScript'])('creates %s with verified initial source and one recording', className => {
  const f = fixture(); const result = f.call('createScript', { parent: 'parent', name: 'Main', className, source: 'return 5' });
  expect(result.success).toBe(true); expect(result.revision).toEqual(expect.any(String));
  expect(f.created[0].Source).toBe('return 5'); expect(f.created[0].Parent).toBeDefined();
  if (className !== 'ModuleScript') expect(f.created[0].Enabled).toBe(false);
  expect(f.finish).toHaveBeenCalledWith('undo', true);
});

test('creation collision constructs nothing; failed initialization destroys only the new instance', () => {
  const request = { parent: 'parent', name: 'Main', className: 'Script', source: '' };
  const collision = fixture(); collision.collide();
  expect(collision.call('createScript', request).error).toContain('name_collision'); expect(collision.created).toHaveLength(0);
  const broken = fixture(); broken.failRead();
  expect(broken.call('createScript', request).error).toContain('read failed');
  expect(broken.created[0].Destroy).toHaveBeenCalledTimes(1); expect(broken.created[0].Parent).toBeUndefined(); expect(broken.finish).toHaveBeenCalledWith('undo', false);
});

test('direct HTTP input validation rejects malformed edits and illegal creation options', () => {
  for (const edits of [[], {}, [null], [{ old_string: '', new_string: 'x' }], [{ old_string: 'x', new_string: 'y', replace_all: 'yes' }]]) {
    expect(() => scriptEditingPayload({ instancePath: 'script', edits }, 'preview')).toThrow();
  }
  expect(() => scriptEditingPayload({ instancePath: 'script', edits: [{ old_string: 'x', new_string: 'y' }] }, 'edit')).toThrow('expected_revision');
  expect(() => scriptEditingPayload({ parent: 'p', name: 'm', className: 'ModuleScript', source: '', enabled: false }, 'create')).toThrow('enabled');
});
