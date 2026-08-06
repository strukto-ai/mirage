// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import {
  CLISpec,
  RAMNamespaceStore,
  RAMWorkspaceStateStore,
  RedisFileCacheStore,
  RedisNamespaceStore,
  RedisWorkspaceStateStore,
  ScriptSource,
} from '@struktoai/mirage-node'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  interpolateEnv,
  loadWorkspaceConfig,
  loadWorkspaceConfigFile,
  configToWorkspaceArgs,
} from './config.ts'

describe('interpolateEnv', () => {
  it('substitutes ${VAR} from env', () => {
    expect(interpolateEnv('hi ${NAME}', { NAME: 'sam' })).toBe('hi sam')
  })

  it('walks nested dicts and lists', () => {
    const out = interpolateEnv({ a: ['${X}', { b: '${X}' }] }, { X: '1' })
    expect(out).toEqual({ a: ['1', { b: '1' }] })
  })

  it('throws listing all missing vars', () => {
    expect(() => interpolateEnv('${A} ${B}', {})).toThrow(/missing.*A.*B/)
  })
})

describe('loadWorkspaceConfig', () => {
  it('parses YAML and validates required fields', () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram', mode: 'write' } },
    })
    expect(cfg.mounts['/']?.resource).toBe('ram')
  })

  it('rejects configs missing mounts', () => {
    expect(() => loadWorkspaceConfig({})).toThrow(/mounts/)
  })
})

describe('configToWorkspaceArgs', () => {
  it('builds resources + mode for Workspace constructor', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram', mode: 'write' } },
      mode: 'write',
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.resources['/']).toBeDefined()
    expect(args.options.mode).toBe('write')
  })

  it('lower-cases mount mode and rejects invalid values', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram', mode: 'WRITE' } },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.mode).toBe('write')

    const bad = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      mode: 'writ',
    })
    await expect(configToWorkspaceArgs(bad)).rejects.toThrow(/invalid mount mode/)
  })

  it('builds runtime entries from the ordered list', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [
        { name: 'pyodide', config: { home: 'https://assets.example.com/pyodide/' } },
        'quickjs',
        'vfs',
      ],
    })
    const args = await configToWorkspaceArgs(cfg)
    const entries = args.options.runtimes
    expect(entries).toBeDefined()
    expect(entries).toHaveLength(3)
    expect((entries?.[0] as { name: string }).name).toBe('pyodide')
    expect((entries?.[1] as { name: string }).name).toBe('quickjs')
    expect((entries?.[2] as { name: string }).name).toBe('vfs')
  })

  it('camelizes the snake_case keys of a runtime entry config block', async () => {
    // Yaml carries Python-shaped keys; the TS runtime config classes
    // are camelCase, so the loader must translate the block's keys
    // (values, like an env map, pass through untouched).
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [
        { name: 'pyodide', config: { auto_load_from_imports: false, home: '/assets' } },
        'vfs',
      ],
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.runtimes).toHaveLength(2)
  })

  it('rejects a flat option on a runtime entry (knobs live in config)', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [{ name: 'pyodide', home: '/assets' }],
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(
      /unknown pyodide runtime option 'home'/,
    )
  })

  it('rejects an unknown runtime entry name', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: ['nosuchruntime'],
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/unknown runtime/)
  })

  it("hints that 'wasi' is Python-only", async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: ['wasi'],
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/Python-only/)
  })

  it('rejects non-script options on the vfs entry', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [{ name: 'vfs', home: '/x' }],
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/unknown vfs runtime option 'home'/)
  })

  it('resolves script paths against the config file dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'policy.py'), "'quickjs'")
    writeFileSync(join(dir, 'ws.yaml'), 'mounts:\n  /data:\n    resource: ram\npolicy: policy.py\n')
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.policy).toEqual(new ScriptSource("'quickjs'"))
    rmSync(dir, { recursive: true, force: true })
  })

  it('a .js policy path stamps the script language', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'policy.js'), 'null')
    writeFileSync(join(dir, 'ws.yaml'), 'mounts:\n  /data:\n    resource: ram\npolicy: policy.js\n')
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    // toEqual compares fields, so a python-tagged source would fail.
    expect(args.options.policy).toEqual(new ScriptSource('null', 'js'))
    expect(args.options.policy).not.toEqual(new ScriptSource('null'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('carries vfs captures through', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [{ name: 'vfs', captures: ['grep', 'cat'] }],
    })
    const args = await configToWorkspaceArgs(cfg)
    const entry = args.options.runtimes?.[0] as { captures: readonly string[] }
    expect([...entry.captures]).toEqual(['grep', 'cat'])
  })

  it('carries entry scripts and the global policy through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'entry.py'), "ctx['command'] == 'node'")
    writeFileSync(join(dir, 'vfs.py'), 'True')
    writeFileSync(join(dir, 'policy.py'), "'quickjs'")
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [
        { name: 'quickjs', script: join(dir, 'entry.py') },
        { name: 'vfs', script: join(dir, 'vfs.py') },
      ],
      policy: join(dir, 'policy.py'),
    })
    const args = await configToWorkspaceArgs(cfg)
    const entries = args.options.runtimes
    expect((entries?.[0] as { script?: ScriptSource }).script).toEqual(
      new ScriptSource("ctx['command'] == 'node'"),
    )
    expect((entries?.[1] as { name: string }).name).toBe('vfs')
    expect((entries?.[1] as { script?: ScriptSource }).script).toEqual(new ScriptSource('True'))
    expect(args.options.policy).toEqual(new ScriptSource("'quickjs'"))
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects inline monty source in config', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      policy: "'quickjs'",
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/reference a \.py\/\.js file/)
  })

  it('builds a redis index config from an index block', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      index: { type: 'redis', url: 'redis://localhost:6379/0', keyPrefix: 'x:' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.index).toEqual({
      type: 'redis',
      url: 'redis://localhost:6379/0',
      keyPrefix: 'x:',
    })
  })

  it('builds a redis file cache from a cache block', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      cache: { type: 'redis', keyPrefix: 'c:' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.cache).toBeInstanceOf(RedisFileCacheStore)
  })

  it('builds a redis state store from a store block (snake_case key_prefix)', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      store: { type: 'redis', url: 'redis://localhost:6379/4', key_prefix: 'test_store:' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.store).toBeInstanceOf(RedisWorkspaceStateStore)
    expect(args.options.store?.namespace('ws1')).toBeInstanceOf(RedisNamespaceStore)
  })

  it('builds a ram state store from a store block', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      store: { type: 'ram' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.store).toBeInstanceOf(RAMWorkspaceStateStore)
    expect(args.options.store?.namespace('ws1')).toBeInstanceOf(RAMNamespaceStore)
  })

  it('routes a per-group override to its own backend', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      store: {
        type: 'ram',
        observer: { type: 'redis', url: 'redis://localhost:6379/4', key_prefix: 'obs:' },
      },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.store).toBeInstanceOf(RAMWorkspaceStateStore)
    expect(args.options.store?.namespace('ws1')).toBeInstanceOf(RAMNamespaceStore)
    expect(args.options.store?.observer('ws1').constructor.name).toBe('RedisObserverStore')
  })

  it('passes workspace_id through (snake_case YAML)', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      workspace_id: 'agent-ws-7',
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.workspaceId).toBe('agent-ws-7')
  })

  it('parses per-mount command_limits (snake_case YAML) into the resource tuple', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: {
        '/': {
          resource: 'ram',
          command_limits: {
            cat: { max_lines: 10, timeout_seconds: 5, on_exceed: 'error' },
          },
        },
      },
    })
    const args = await configToWorkspaceArgs(cfg)
    const limits = args.resources['/']?.[2]
    expect(limits?.cat?.maxLines).toBe(10)
    expect(limits?.cat?.timeoutSeconds).toBe(5)
    expect(limits?.cat?.onExceed).toBe('error')
  })

  it('defaults to no command_limits when omitted', async () => {
    const cfg = loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.resources['/']?.[2]).toEqual({})
  })

  it('rejects an invalid on_exceed value', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram', command_limits: { cat: { on_exceed: 'boom' } } } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/invalid onExceed/)
  })

  it('reads snake_case default_session_id / default_agent_id (Python YAML)', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      default_session_id: 'sess-1',
      default_agent_id: 'agent-1',
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.sessionId).toBe('sess-1')
    expect(args.options.agentId).toBe('agent-1')
  })

  it('reads snake_case index key_prefix into the index config', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      index: { type: 'redis', url: 'redis://localhost:6379/0', key_prefix: 'idx:' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.index).toEqual({
      type: 'redis',
      url: 'redis://localhost:6379/0',
      keyPrefix: 'idx:',
    })
  })

  it('builds a redis cache from snake_case key_prefix / max_drain_bytes', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      cache: { type: 'redis', key_prefix: 'c:', max_drain_bytes: 1024 },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.cache).toBeInstanceOf(RedisFileCacheStore)
  })

  it('coerces consistency (default lazy, accepts always, rejects junk)', async () => {
    const dflt = await configToWorkspaceArgs(
      loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } }),
    )
    expect(dflt.options.consistency).toBe('lazy')
    const always = await configToWorkspaceArgs(
      loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } }, consistency: 'ALWAYS' }),
    )
    expect(always.options.consistency).toBe('always')
    await expect(
      configToWorkspaceArgs(
        loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } }, consistency: 'soon' }),
      ),
    ).rejects.toThrow(/invalid consistency/)
  })

  it('threads per-mount backend into top-level kernelMounts and yields {} otherwise', async () => {
    const withFuse = await configToWorkspaceArgs(
      loadWorkspaceConfig({
        mounts: {
          '/data': { resource: 'ram', backend: 'fuse', mountpoint: '/tmp/mt' },
          '/s3': { resource: 'ram', backend: 'fuse' },
          '/logs': { resource: 'ram' },
        },
      }),
    )
    expect(withFuse.kernelMounts).toEqual({
      '/data': ['fuse', '/tmp/mt'],
      '/s3': ['fuse', undefined],
    })
    expect('kernelMounts' in withFuse.options).toBe(false)
    const withoutFuse = await configToWorkspaceArgs(
      loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } }),
    )
    expect(withoutFuse.kernelMounts).toEqual({})
    expect('kernelMounts' in withoutFuse.options).toBe(false)
  })

  it('leaves mount config snake_case keys untouched (resource credentials)', () => {
    const cfg = loadWorkspaceConfig({
      mounts: {
        '/s3': {
          resource: 'ram',
          config: { aws_access_key_id: 'AKIA', endpoint_url: 'http://localhost:9000' },
        },
      },
    })
    expect(cfg.mounts['/s3']?.config).toEqual({
      aws_access_key_id: 'AKIA',
      endpoint_url: 'http://localhost:9000',
    })
  })

  it('guards block compiles to guard specs', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      guards: [
        {
          reason: 'production data is protected',
          commands: ['rm', 'mv'],
          paths: ['/data/prod/*'],
        },
        { reason: 'interpreters are off', commands: ['python3'] },
      ],
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.guards).toEqual([
      {
        reason: 'production data is protected',
        commands: ['rm', 'mv'],
        paths: ['/data/prod/*'],
      },
      { reason: 'interpreters are off', commands: ['python3'] },
    ])
  })

  it('a guard without a reason fails loud', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      guards: [{ commands: ['rm'] }],
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/reason/)
  })

  it('a guard with an unknown key fails loud', async () => {
    // A typo like `path:` would otherwise widen the guard into an
    // unconditional denial (mirrors Python's extra="forbid").
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      guards: [{ reason: 'x', path: ['/data/prod/*'] }],
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/unknown guard key/)
  })
})

describe('clis section', () => {
  // Mirrors python/tests/config/test_loader.py's clis tests.
  it('parses and maps to the Workspace clis option', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: {
        sl: { cli: 'slack', config: { token: 'x' } },
        bare: { cli: 'gws' },
      },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.clis).toEqual({
      sl: ['slack', { token: 'x' }],
      bare: ['gws', {}],
    })
  })

  it('refuses unknown keys in a clis entry', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { sl: { cli: 'slack', mode: 'write' } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/unknown keys: mode/)
  })

  it('a script entry synthesizes a spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'pager.py'), "print('page')")
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\n' +
        'clis:\n  pager:\n    script: pager.py\n    runtime: monty\n' +
        '    config:\n      page_size: 20\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    const [spec, config] = args.options.clis?.pager ?? []
    expect(spec).toBeInstanceOf(CLISpec)
    expect((spec as CLISpec).name).toBe('pager')
    expect((spec as CLISpec).script).toEqual(new ScriptSource("print('page')"))
    expect((spec as CLISpec).runtime).toBe('monty')
    expect(config).toEqual({ page_size: 20 })
    rmSync(dir, { recursive: true, force: true })
  })

  it('a .mjs script stamps the language and the module bit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'pager.mjs'), "console.log('page')")
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nclis:\n  pager:\n    script: pager.mjs\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    const [spec] = args.options.clis?.pager ?? []
    // The module bit rides on the spec because the path is gone once
    // the source is embedded, and an ES module needs the engine's
    // module mode or `import` fails.
    expect((spec as CLISpec).script).toEqual(new ScriptSource("console.log('page')", 'js', true))
    rmSync(dir, { recursive: true, force: true })
  })

  it('a plain .js script is not a module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'pager.js'), "console.log('page')")
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nclis:\n  pager:\n    script: pager.js\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    const [spec] = args.options.clis?.pager ?? []
    expect((spec as CLISpec).script?.language).toBe('js')
    expect((spec as CLISpec).script?.module).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a clis entry takes exactly one of cli or script', async () => {
    const both = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { sl: { cli: 'slack', script: 'pager.py' } },
    })
    await expect(configToWorkspaceArgs(both)).rejects.toThrow(/exactly one of cli or script/)
    const neither = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { sl: { config: { token: 'x' } } },
    })
    await expect(configToWorkspaceArgs(neither)).rejects.toThrow(/exactly one of cli or script/)
  })

  it('runtime takes script', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { sl: { cli: 'slack', runtime: 'monty' } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/it takes script/)
  })
})
