import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: unknown[]) => unknown, ...args: unknown[]): [boolean, unknown] {
  try {
    return [true, callback(...args)];
  } catch (error) {
    return [false, error];
  }
}

async function loadPluginModule<T>(
  relativePath: string,
  globals: Record<string, unknown>,
  plugins: Plugin[] = [],
): Promise<T> {
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins,
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    ...globals,
  });

  vm.runInContext(`
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.size = function() {
      return String(this).length;
    };
    String.prototype.sub = function(start, end) {
      return String(this).slice(start < 0 ? start : start - 1, end);
    };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  return commonJsModule.exports as T;
}

describe('script source update safety', () => {
  test('strict paths preserve renamed service roots and reject duplicate children', async () => {
    const child = { Name: 'Main' };
    let children = [child];
    const service = { Name: 'Renamed', GetChildren: () => ({
      filter: (predicate: (value: { Name: string }) => boolean) => {
        const matches = children.filter(predicate);
        return Object.assign(matches, { size: () => matches.length });
      },
    }) };
    const utils = await loadPluginModule<{ getInstanceByPathStrict(path: string): unknown }>(
      'studio-plugin/src/modules/Utils.ts', {
        game: { GetService: () => service },
        pcall: robloxPcall,
        error: (message: string) => { throw new Error(message); },
      },
    );
    expect(utils.getInstanceByPathStrict('game.ServerScriptService.Main')).toBe(child);
    children = [child, { Name: 'Main' }];
    expect(() => utils.getInstanceByPathStrict('game.ServerScriptService.Main')).toThrow('ambiguous_path');
    children = [];
    expect(utils.getInstanceByPathStrict('game.ServerScriptService.Main')).toBeUndefined();
  });

  test('a source change inside the editor callback is not overwritten by the fallback', async () => {
    let source = 'original';
    const directWrite = jest.fn();
    const instance = {};
    Object.defineProperty(instance, 'Source', { get: () => source, set: directWrite });
    const utils = await loadPluginModule<{
      applyScriptSource(target: object, value: string, expected: string): { success: boolean };
    }>('studio-plugin/src/modules/Utils.ts', {
      game: { GetService: () => ({
        GetEditorSource: () => source,
        UpdateSourceAsync: (_target: unknown, callback: (current: string) => string) => {
          source = 'concurrent editor change';
          source = callback(source);
        },
      }) },
      pcall: robloxPcall,
      error: (message: string) => { throw new Error(message); },
      warn: jest.fn(),
    });
    expect(utils.applyScriptSource(instance, 'replacement', 'original').success).toBe(false);
    expect(source).toBe('concurrent editor change');
    expect(directWrite).not.toHaveBeenCalled();
  });

  test('reads the edit-time source used by Studio search', async () => {
    const getEditorSource = jest.fn(() => 'unsaved editor source');
    const script = { Source: 'saved source' };
    const utils = await loadPluginModule<{
      readScriptSource(target: object): string;
    }>('studio-plugin/src/modules/Utils.ts', {
      game: {
        GetService: () => ({
          GetEditorSource: getEditorSource,
          FindScriptDocument: () => undefined,
        }),
      },
      pcall: robloxPcall,
      warn: jest.fn(),
    });

    expect(utils.readScriptSource(script)).toBe('unsaved editor source');
    expect(getEditorSource).toHaveBeenCalledWith(script);
  });

  test('applyScriptSource leaves the original instance intact when both in-place writes fail', async () => {
    const parent = { name: 'parent' };
    const destroy = jest.fn();
    const source = 'old source';
    const instance = { Parent: parent, Destroy: destroy };
    Object.defineProperty(instance, 'Source', {
      get: () => source,
      set: () => {
        throw new Error('direct assignment blocked');
      },
    });
    const updateSourceAsync = jest.fn(() => {
      throw new Error('editor update blocked');
    });

    const utils = await loadPluginModule<{
      applyScriptSource: (
        target: object,
        newSource: string,
      ) => { success: boolean; error?: string };
    }>('studio-plugin/src/modules/Utils.ts', {
      game: {
        GetService: () => ({
          FindScriptDocument: () => undefined,
          UpdateSourceAsync: updateSourceAsync,
        }),
      },
      pcall: robloxPcall,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      warn: jest.fn(),
    });

    const result = utils.applyScriptSource(instance, 'new source');

    expect(result.success).toBe(false);
    expect(result.error).toContain('editor update blocked');
    expect(result.error).toContain('direct assignment blocked');
    expect(source).toBe('old source');
    expect(instance.Parent).toBe(parent);
    expect(destroy).not.toHaveBeenCalled();
  });

  test('setScriptSource returns the in-place failure without constructing a replacement', async () => {
    const parent = { name: 'parent' };
    const destroy = jest.fn();
    const original = {
      Name: 'Main',
      ClassName: 'ModuleScript',
      Parent: parent,
      attributes: { preserved: true },
      Destroy: destroy,
      IsA: (className: string) => className === 'LuaSourceContainer',
    };
    const replacement = {
      Name: '',
      ClassName: 'ModuleScript',
      Parent: undefined as object | undefined,
      Source: '',
      IsA: () => false,
    };
    const instanceConstructor = jest.fn(function MockInstance() {
      return replacement;
    });
    const applyScriptSource = jest.fn(() => ({
      success: false,
      method: 'direct',
      error: 'UpdateSourceAsync failed: editor blocked. Direct assignment failed: source locked.',
    }));
    const finishRecording = jest.fn();

    const dependencyPlugin: Plugin = {
      name: 'script-source-test-dependencies',
      setup(build) {
        build.onResolve({ filter: /^\.\.\/Utils$/ }, () => ({
          path: 'Utils',
          namespace: 'script-source-test',
        }));
        build.onResolve({ filter: /^\.\.\/Recording$/ }, () => ({
          path: 'Recording',
          namespace: 'script-source-test',
        }));
        build.onLoad({ filter: /.*/, namespace: 'script-source-test' }, (args) => ({
          contents: args.path === 'Utils'
            ? 'export default globalThis.__SCRIPT_SOURCE_TEST_UTILS__;'
            : 'export default globalThis.__SCRIPT_SOURCE_TEST_RECORDING__;',
          loader: 'js',
        }));
      },
    };
    const loaded = await loadPluginModule<{
      default?: { setScriptSource: (request: Record<string, unknown>) => Record<string, unknown> };
      setScriptSource?: (request: Record<string, unknown>) => Record<string, unknown>;
    }>('studio-plugin/src/modules/handlers/ScriptHandlers.ts', {
      __SCRIPT_SOURCE_TEST_UTILS__: {
        getInstancePath: () => 'game.ServerScriptService.Main',
        getInstanceByPath: () => original,
        readScriptSource: (target: unknown) => target === original ? 'old source' : replacement.Source,
        applyScriptSource,
        splitLines: jest.fn(),
        joinLines: jest.fn(),
      },
      __SCRIPT_SOURCE_TEST_RECORDING__: {
        beginRecording: () => 'recording-id',
        finishRecording,
      },
      typeIs: (value: unknown, expectedType: string) => typeof value === expectedType,
      pcall: robloxPcall,
      error: (message: unknown) => {
        throw new Error(String(message));
      },
      Instance: instanceConstructor,
    }, [dependencyPlugin]);
    const handlers = loaded.default ?? loaded;

    const result = handlers.setScriptSource!({
      instancePath: 'game.ServerScriptService.Main',
      source: 'new source',
    });

    expect(result.error).toContain('UpdateSourceAsync failed: editor blocked');
    expect(result.success).not.toBe(true);
    expect(applyScriptSource).toHaveBeenCalledWith(original, 'new source');
    expect(instanceConstructor).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(original.Parent).toBe(parent);
    expect(original.attributes).toEqual({ preserved: true });
    expect(finishRecording).toHaveBeenCalledWith('recording-id', false);
  });
});
