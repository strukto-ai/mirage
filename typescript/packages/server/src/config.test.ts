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
        { name: 'pyodide', home: 'https://assets.example.com/pyodide/' },
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

  it('rejects an unknown runtime entry name', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: ['docker'],
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
    writeFileSync(join(dir, 'route.py'), "'quickjs'")
    writeFileSync(join(dir, 'ws.yaml'), 'mounts:\n  /data:\n    resource: ram\nroute: route.py\n')
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.route).toEqual(new ScriptSource("'quickjs'"))
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

  it('carries entry scripts and the global route through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'entry.py'), "ctx['command'] == 'node'")
    writeFileSync(join(dir, 'vfs.py'), 'True')
    writeFileSync(join(dir, 'route.py'), "'quickjs'")
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      runtimes: [
        { name: 'quickjs', script: join(dir, 'entry.py') },
        { name: 'vfs', script: join(dir, 'vfs.py') },
      ],
      route: join(dir, 'route.py'),
    })
    const args = await configToWorkspaceArgs(cfg)
    const entries = args.options.runtimes
    expect((entries?.[0] as { script?: ScriptSource }).script).toEqual(
      new ScriptSource("ctx['command'] == 'node'"),
    )
    expect((entries?.[1] as { name: string }).name).toBe('vfs')
    expect((entries?.[1] as { script?: ScriptSource }).script).toEqual(new ScriptSource('True'))
    expect(args.options.route).toEqual(new ScriptSource("'quickjs'"))
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects inline monty source in config', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      route: "'quickjs'",
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/reference a \.py file/)
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

  it('parses per-mount command_safeguards (snake_case YAML) into the resource tuple', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: {
        '/': {
          resource: 'ram',
          command_safeguards: {
            cat: { max_lines: 10, timeout_seconds: 5, on_exceed: 'error' },
          },
        },
      },
    })
    const args = await configToWorkspaceArgs(cfg)
    const safeguards = args.resources['/']?.[2]
    expect(safeguards?.cat?.maxLines).toBe(10)
    expect(safeguards?.cat?.timeoutSeconds).toBe(5)
    expect(safeguards?.cat?.onExceed).toBe('error')
  })

  it('defaults to no command_safeguards when omitted', async () => {
    const cfg = loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.resources['/']?.[2]).toEqual({})
  })

  it('rejects an invalid on_exceed value', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram', command_safeguards: { cat: { on_exceed: 'boom' } } } },
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

  it('threads per-mount fuse into top-level fuseMounts and yields {} otherwise', async () => {
    const withFuse = await configToWorkspaceArgs(
      loadWorkspaceConfig({
        mounts: {
          '/data': { resource: 'ram', fuse: '/tmp/mt' },
          '/s3': { resource: 'ram', fuse: true },
          '/logs': { resource: 'ram' },
        },
      }),
    )
    expect(withFuse.fuseMounts).toEqual({ '/data': '/tmp/mt', '/s3': true })
    expect('fuseMounts' in withFuse.options).toBe(false)
    const withoutFuse = await configToWorkspaceArgs(
      loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } }),
    )
    expect(withoutFuse.fuseMounts).toEqual({})
    expect('fuseMounts' in withoutFuse.options).toBe(false)
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
})
