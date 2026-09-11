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

import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { Runtime } from '@struktoai/mirage-core/runtime/base'
import { ScriptSource } from '@struktoai/mirage-core/runtime/routing/index'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMNamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/ram'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { buildFileCache } from '@struktoai/mirage-core/workspace/workspace/cache'
import { DiskNamespaceStore } from './workspace/namespace/disk.ts'
import { RedisNamespaceStore } from './workspace/namespace/redis.ts'
import { DiskWorkspaceStateStore } from './workspace/store/disk.ts'
import { RedisWorkspaceStateStore } from './workspace/store/redis.ts'
import { RedisConsoleStore } from './shell/console/redis/index.ts'
import { RedisFileCacheStore } from './cache/file/redis.ts'
import { Workspace } from './workspace.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  absolutizeScripts,
  checkWorkspaceConfigFile,
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

describe('absolutizeScripts', () => {
  // The CLI applies this to a `load`/`clone` override on its own, since an
  // override is read without validation; a relative code ref there has to
  // mean "next to the file" exactly as it does at create time.
  it('rebases relative resource and cli refs onto the config dir, not dotpaths', () => {
    const raw: Record<string, unknown> = {
      mounts: {
        '/wiki': { resource: './backends/wiki.mjs:WikiResource' },
        '/pkg': { resource: 'my-pkg/backends:WikiResource' },
        '/ram': { resource: 'ram' },
      },
      clis: { tally: { cli: '../tools/tally.mjs:TALLY' } },
    }
    absolutizeScripts(raw, '/srv/deploy')
    const mounts = raw.mounts as Record<string, { resource: string }>
    const clis = raw.clis as Record<string, { cli: string }>
    expect(mounts['/wiki']?.resource).toBe('/srv/deploy/backends/wiki.mjs:WikiResource')
    expect(mounts['/pkg']?.resource).toBe('my-pkg/backends:WikiResource')
    expect(mounts['/ram']?.resource).toBe('ram')
    expect(clis.tally?.cli).toBe('/srv/tools/tally.mjs:TALLY')
  })

  it('rebases a runtime entry name that is a code ref, not a registered name', () => {
    const raw: Record<string, unknown> = {
      runtimes: [
        { name: './box.mjs:EchoBox', captures: ['nvidia-smi'] },
        { name: 'monty' },
        '../box.mjs:EchoBox',
        'my-runtimes:EchoBox',
        'vfs',
      ],
    }
    absolutizeScripts(raw, '/srv/deploy')
    const runtimes = raw.runtimes as ({ name: string } | string)[]
    expect(runtimes[0]).toEqual({ name: '/srv/deploy/box.mjs:EchoBox', captures: ['nvidia-smi'] })
    expect(runtimes[1]).toEqual({ name: 'monty' })
    expect(runtimes[2]).toBe('/srv/box.mjs:EchoBox')
    expect(runtimes[3]).toBe('my-runtimes:EchoBox')
    expect(runtimes[4]).toBe('vfs')
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
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nroute_policy: policy.py\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.routePolicy).toEqual(new ScriptSource("'quickjs'"))
    rmSync(dir, { recursive: true, force: true })
  })

  it('a .js policy path stamps the script language', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-cfg-'))
    writeFileSync(join(dir, 'policy.js'), 'null')
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nroute_policy: policy.js\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    // toEqual compares fields, so a python-tagged source would fail.
    expect(args.options.routePolicy).toEqual(new ScriptSource('null', 'js'))
    expect(args.options.routePolicy).not.toEqual(new ScriptSource('null'))
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
      route_policy: join(dir, 'policy.py'),
    })
    const args = await configToWorkspaceArgs(cfg)
    const entries = args.options.runtimes
    expect((entries?.[0] as { script?: ScriptSource }).script).toEqual(
      new ScriptSource("ctx['command'] == 'node'"),
    )
    expect((entries?.[1] as { name: string }).name).toBe('vfs')
    expect((entries?.[1] as { script?: ScriptSource }).script).toEqual(new ScriptSource('True'))
    expect(args.options.routePolicy).toEqual(new ScriptSource("'quickjs'"))
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects inline monty source in config', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      route_policy: "'quickjs'",
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/reference a \.py\/\.js file/)
  })

  // The camelCase spelling of a snake_case config key is a key Python
  // rejects, so accepting it here would make the same YAML load in one
  // language and fail in the other. See the snake_case twins below.
  it('refuses the camelCase spelling of a config key', () => {
    for (const block of [
      { index: { type: 'redis', keyPrefix: 'x:' } },
      { cache: { type: 'redis', keyPrefix: 'c:' } },
      { cache: { type: 'ram', maxDrainBytes: 8 } },
    ]) {
      expect(() => loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } }, ...block })).toThrow(
        /unknown (cache|index)/,
      )
    }
  })

  it('builds a redis state store from a store block (snake_case key_prefix)', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      store: { type: 'redis', url: 'redis://localhost:6379/4', key_prefix: 'test_store:' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.store).toBeInstanceOf(RedisWorkspaceStateStore)
    expect(args.options.store?.namespace('ws1')).toBeInstanceOf(RedisNamespaceStore)
    // A store built here has no other owner, so the workspace must be
    // told to close it — without this the redis client is never quit.
    expect(args.options.ownsStore).toBe(true)
  })

  it('hands the workspace a store it will actually close', async () => {
    // The store built here has no other owner, so a workspace that
    // treats it as borrowed leaks it — for redis or s3 that is a client
    // that is never quit, once per workspace the daemon creates.
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      store: { type: 'ram' },
    })
    const args = await configToWorkspaceArgs(cfg)
    const store = args.options.store
    if (store === undefined) throw new Error('the store block built no store')
    let closed = 0
    store.close = () => {
      closed++
      return Promise.resolve()
    }
    const ws = new Workspace({}, args.options)
    await ws.close()
    expect(closed).toBe(1)
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

  it('builds a disk state store from a store block', async () => {
    // `store: {type: disk}` used to build a RAM store here while Python
    // built a disk one, so state a user believed was persisted was not.
    const dir = mkdtempSync(join(tmpdir(), 'mirage-store-'))
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      store: { type: 'disk', root: dir },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.store).toBeInstanceOf(DiskWorkspaceStateStore)
    expect(args.options.store?.namespace('ws1')).toBeInstanceOf(DiskNamespaceStore)
    rmSync(dir, { recursive: true, force: true })
  })

  it('takes an s3 group as the workspace override, credentials intact', async () => {
    // An s3 group IS an S3Config, whose snake_case keys do not camelize
    // into the TS field names (`aws_access_key_id` is `accessKeyId`, not
    // `awsAccessKeyId`), so a plain camelize would silently drop the
    // credentials and endpoint and authenticate against the wrong thing.
    const raw = {
      mounts: { '/': { resource: 'ram' } },
      store: {
        type: 'ram',
        workspace: {
          type: 's3',
          bucket: 'b',
          region: 'us-east-1',
          aws_access_key_id: 'AKIA',
          aws_secret_access_key: 'secret',
          endpoint_url: 'http://localhost:9000',
          path_style: true,
          timeout: 5,
        },
      },
    }
    const cfg = loadWorkspaceConfig(raw)
    const group = (cfg.store as unknown as { workspace: Record<string, unknown> }).workspace
    expect(group.aws_access_key_id).toBe('AKIA')
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.store?.namespace('ws1')).toBeInstanceOf(RAMNamespaceStore)
    const s3 = (
      args.options.store as unknown as {
        workspaceOverride: { config: Record<string, unknown> }
      }
    ).workspaceOverride
    expect(s3.config).toMatchObject({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      timeoutMs: 5000,
      keyPrefix: 'mirage/',
    })
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

  it('hands a redis cache to the workspace as config, not as a store', async () => {
    // The workspace builds it, so the workspace closes it; building it
    // here would leave the redis client with no owner at shutdown.
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      cache: { type: 'redis', key_prefix: 'c:', max_drain_bytes: 1024 },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.cache).toEqual({
      type: 'redis',
      keyPrefix: 'c:',
      maxDrainBytes: 1024,
    })
    expect(buildFileCache(args.options.cache)).toBeInstanceOf(RedisFileCacheStore)
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

  it('the permissions document maps to workspace args', async () => {
    // `mounts:` is infrastructure and `profiles:` is every permission
    // the deployment states, including the per-mount ones; there is no
    // workspace `permissions:` block and no `permissions:` on a mount.
    const cfg = loadWorkspaceConfig({
      mounts: {
        '/repo': { resource: 'ram' },
        '/scratch': { resource: 'ram', mode: 'rwx' },
      },
      profile: 'reviewer',
      profiles: {
        default: {
          cwd: '/scratch',
          env: { PAGER: 'cat' },
          mounts: { '/repo': 'r', '/scratch': 'rwx' },
          commands: {
            deny: [
              {
                reason: 'production data is protected',
                commands: { rm: ['/repo/prod/*'], mv: ['/repo/prod/*'] },
              },
              'python3',
            ],
          },
          paths: { hide: ['/scratch/finance'] },
        },
        reviewer: {
          mounts: { '/repo': { mode: 'r', paths: { hide: ['/repo/*.pem', '/repo/.env'] } } },
          paths: { hide: ['/repo/docs/internal'] },
          vars: { hide: ['AWS_*', 'SLACK_TOKEN'] },
        },
      },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.profile).toBe('reviewer')
    expect(args.options.profiles?.default).toEqual({
      cwd: '/scratch',
      env: { PAGER: 'cat' },
      mounts: new Map([
        ['/repo', { mode: MountMode.READ }],
        ['/scratch', { mode: MountMode.EXEC }],
      ]),
      commands: {
        allow: null,
        ask: [],
        deny: [
          { reason: 'production data is protected', commands: ['rm'], paths: ['/repo/prod/*'] },
          { reason: 'production data is protected', commands: ['mv'], paths: ['/repo/prod/*'] },
          { reason: 'denied by policy', commands: ['python3'] },
        ],
      },
      paths: { hide: ['/scratch/finance'] },
    })
    expect(args.options.profiles?.reviewer).toEqual({
      mounts: new Map([
        ['/repo', { mode: MountMode.READ, paths: { hide: ['/repo/*.pem', '/repo/.env'] } }],
      ]),
      paths: { hide: ['/repo/docs/internal'] },
      vars: { hide: ['AWS_*', 'SLACK_TOKEN'] },
    })
    expect(args.resources['/scratch']?.[1]).toBe(MountMode.EXEC)
  })

  it('a deny rule with an unknown key fails at load', () => {
    // A typo like `path:` would otherwise widen the rule into an
    // unconditional denial (mirrors Python's extra="forbid"), and like
    // Python it must fail at load, not when the args are built.
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        profiles: {
          default: { commands: { deny: [{ reason: 'x', path: ['/data/prod/*'] }] } },
        },
      }),
    ).toThrow(/deny\[0\]: unknown field `path`/)
  })

  it('unshipped and misspelled fields fail at load', () => {
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        profiles: { a: { hidden_paths: { paths: ['/x'] } } },
      }),
    ).toThrow(/unknown field `hidden_paths`/)
    // A mount section has no allow list, and a mount block has no
    // permissions of its own any more.
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        profiles: { a: { mounts: { '/data': { commands: { allow: ['ls'] } } } } },
      }),
    ).toThrow(/unknown field `allow`/)
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram', permissions: { paths: { hide: ['x'] } } } },
      }),
    ).toThrow(/unknown mount `\/data` key `permissions`/)
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        profiles: { orphan: { extends: 'gone' } },
      }),
    ).toThrow(/unknown field `extends`/)
  })

  it('console redis block builds a factory that mints fresh keys', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      console: { type: 'redis', url: 'redis://localhost:6379/5', key_prefix: 'test_console:' },
    })
    const args = await configToWorkspaceArgs(cfg)
    const factory = args.options.consoleFactory
    expect(factory).toBeDefined()
    const prefixOf = (jobId: number): string => {
      const store = factory?.(jobId).store
      if (!(store instanceof RedisConsoleStore)) throw new Error('expected a RedisConsoleStore')
      return store.keyPrefix
    }
    const first = prefixOf(1)
    const second = prefixOf(1)
    // Fresh keys per console: job ids restart at 1 when the table
    // empties, so two consoles built for "job 1" must not share a
    // stream (a shared one would replay the first job's chunks). The
    // minted prefix is public: it is the address an embedder hands to
    // a reader in another process.
    expect(first).not.toBe(second)
    expect(first.startsWith('test_console:')).toBe(true)
  })

  it('console ram block leaves consoles in memory', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      console: { type: 'ram' },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.consoleFactory).toBeUndefined()
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

  it('refuses unknown keys in a clis entry', () => {
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        clis: { sl: { cli: 'slack', mode: 'write' } },
      }),
    ).toThrow(/unknown cli `sl` key `mode`/)
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

  it('a script entry refuses a secrets pointer', () => {
    // A script's config is opaque: nothing declares which key is a
    // credential, so the snapshot captures it verbatim, and a pointer
    // resolved into it would be written out as the value it fetched. A
    // script reads a credential from a managed env var instead.
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        clis: {
          pager: { script: 'pager.py', config: { token: { from: 'env', key: 'PAGER_TOKEN' } } },
        },
      }),
    ).toThrow(/clis entry 'pager'.*opaque/)
    // A literal in a script's config is the script's own business.
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { pager: { script: 'pager.py', config: { verbose: true } } },
    })
    expect(cfg.clis?.pager?.config).toEqual({ verbose: true })
  })
})

// Mirrors python/tests/config/test_loader.py's runtimes `name:` cases. A
// runtime entry name carrying a colon names a Runtime subclass the way
// `resource:` names a backend, so a deployment ships a runtime as a file
// with no host program calling registerRuntime.
describe('runtimes name: reference', () => {
  const CORE = pathToFileURL(
    resolve(fileURLToPath(import.meta.url), '../../../core/dist/index.js'),
  ).href
  const BOX =
    `import {LINE_EXECUTOR, Runtime} from ${JSON.stringify(CORE)}\n` +
    'export class EchoBox extends Runtime {\n' +
    '  [LINE_EXECUTOR] = true\n' +
    "  name = 'echobox'\n" +
    "  constructor(options = {}) { super(options, ['nvidia-smi'], []) }\n" +
    '  runLine(line) { return Promise.resolve({ stdout: new TextEncoder().encode(`box:${line}\\n`), stderr: null, exitCode: 0 }) }\n' +
    '}\n' +
    "export const NOT_A_RUNTIME = { name: 'nope' }\n"

  it('builds a runtime out of a file next to the config, with the entry options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-rt-'))
    writeFileSync(join(dir, 'box.mjs'), BOX)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\n' +
        'runtimes:\n  - name: ./box.mjs:EchoBox\n    captures: [nvidia-smi, rocm-smi]\n  - vfs\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.runtimes?.[0]).toEqual({
      name: `${join(dir, 'box.mjs')}:EchoBox`,
      captures: ['nvidia-smi', 'rocm-smi'],
    })
    const args = await configToWorkspaceArgs(cfg)
    const [box, vfs] = args.options.runtimes ?? []
    expect(box).toBeInstanceOf(Runtime)
    expect((box as Runtime).name).toBe('echobox')
    expect((box as Runtime).captures).toEqual(['nvidia-smi', 'rocm-smi'])
    expect((vfs as Runtime).name).toBe('vfs')
    rmSync(dir, { recursive: true, force: true })
  })

  it('checks the entry keys of a referenced runtime the way a named one is checked', async () => {
    // The base constructor ignores a key it does not read, so without
    // the check `captuers:` would leave EchoBox on its class captures;
    // Python refuses the same entry through `**options`.
    const dir = mkdtempSync(join(tmpdir(), 'mirage-rt-'))
    writeFileSync(join(dir, 'box.mjs'), BOX)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\n' +
        'runtimes:\n  - name: ./box.mjs:EchoBox\n    captuers: [nvidia-smi, rocm-smi]\n  - vfs\n',
    )
    await expect(
      configToWorkspaceArgs(loadWorkspaceConfigFile(join(dir, 'ws.yaml'))),
    ).rejects.toThrow(/unknown .*box\.mjs:EchoBox runtime option 'captuers'/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a ref that is not a Runtime subclass, and one that does not load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-rt-'))
    writeFileSync(join(dir, 'box.mjs'), BOX)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nruntimes:\n  - ./box.mjs:NOT_A_RUNTIME\n',
    )
    await expect(
      configToWorkspaceArgs(loadWorkspaceConfigFile(join(dir, 'ws.yaml'))),
    ).rejects.toThrow('is not a Runtime subclass')
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nruntimes:\n  - name: ./missing.mjs:EchoBox\n',
    )
    await expect(
      configToWorkspaceArgs(loadWorkspaceConfigFile(join(dir, 'ws.yaml'))),
    ).rejects.toThrow('cannot load script')
    rmSync(dir, { recursive: true, force: true })
  })
})

// Mirrors python/tests/config/test_loader.py's mounts `resource:` cases.
// A `resource` value carrying a colon names a class the same way `cli:`
// names a spec, which is what lets a deployment mount its own backend
// from YAML without registering a factory in a host program.
describe('mounts resource: reference', () => {
  const CORE_RES = pathToFileURL(
    resolve(fileURLToPath(import.meta.url), '../../../core/dist/index.js'),
  ).href
  const BACKEND =
    `import {RAMResource} from ${JSON.stringify(CORE_RES)}\n` +
    'export class WikiResource extends RAMResource {}\n'

  it('builds a resource out of a file next to the config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-res-'))
    writeFileSync(join(dir, 'wiki.mjs'), BACKEND)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /wiki:\n    resource: ./wiki.mjs:WikiResource\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    expect(args.resources['/wiki']?.[0]?.constructor.name).toBe('WikiResource')
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebases a relative ref onto the config file directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-res-'))
    writeFileSync(join(dir, 'wiki.mjs'), BACKEND)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /wiki:\n    resource: ./wiki.mjs:WikiResource\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.mounts['/wiki']?.resource).toBe(`${join(dir, 'wiki.mjs')}:WikiResource`)
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a package specifier alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-res-'))
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /wiki:\n    resource: my-backends:WikiResource\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.mounts['/wiki']?.resource).toBe('my-backends:WikiResource')
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a registry name alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-res-'))
    writeFileSync(join(dir, 'ws.yaml'), 'mounts:\n  /data:\n    resource: ram\n')
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.mounts['/data']?.resource).toBe('ram')
    rmSync(dir, { recursive: true, force: true })
  })
})

// Mirrors python/tests/config/test_loader.py's `cli: ./tool.py:TREE`
// cases. A `cli` value carrying a colon points at code rather than
// naming a registered spec, which is what lets a deployment install its
// own program tree from YAML instead of from a host program.
describe('clis cli: reference', () => {
  // The fixture lives in a tmpdir with no node_modules of its own, so it
  // imports core's built entry by URL. A real deployment's file sits in
  // its own project and writes the bare specifier. Core is ESM-only with
  // no `require` condition, so createRequire cannot resolve it and the
  // path is spelled against this monorepo's layout.
  const CORE = pathToFileURL(
    resolve(fileURLToPath(import.meta.url), '../../../core/dist/index.js'),
  ).href
  const SPEC =
    `import {CLISpec} from ${JSON.stringify(CORE)}\n` +
    "export const TALLY = new CLISpec({name: 'tally', fn: async () => ({exitCode: 0})})\n"

  it('loads a spec out of a file next to the config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(join(dir, 'tally.mjs'), SPEC)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\n' +
        'clis:\n  tally:\n    cli: ./tally.mjs:TALLY\n    config:\n      unit: kg\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    const args = await configToWorkspaceArgs(cfg)
    const [spec, config] = args.options.clis?.tally ?? []
    expect(spec).toBeInstanceOf(CLISpec)
    expect((spec as CLISpec).name).toBe('tally')
    expect(config).toEqual({ unit: 'kg' })
    rmSync(dir, { recursive: true, force: true })
  })

  // The rebase is the whole reason a relative ref is usable: without it
  // the pointer reaches loadAttr relative and resolves against whatever
  // directory the server happens to be running in.
  it('rebases a relative ref onto the config file directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(join(dir, 'tally.mjs'), SPEC)
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nclis:\n  tally:\n    cli: ./tally.mjs:TALLY\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.clis?.tally?.cli).toBe(`${join(dir, 'tally.mjs')}:TALLY`)
    rmSync(dir, { recursive: true, force: true })
  })

  // A package specifier is Node's to resolve, not the filesystem's, so
  // it must survive the rebase untouched.
  it('leaves a package specifier alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nclis:\n  jira:\n    cli: my-clis:JIRA\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.clis?.jira?.cli).toBe('my-clis:JIRA')
    rmSync(dir, { recursive: true, force: true })
  })

  it('a bare name still travels as a name', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { sl: { cli: 'slack' } },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.clis?.sl?.[0]).toBe('slack')
  })

  it('refuses a ref that resolves to something other than a CLISpec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(join(dir, 'nope.mjs'), 'export const TALLY = {name: "tally"}\n')
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { tally: { cli: `${join(dir, 'nope.mjs')}:TALLY` } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/is not a CLISpec/)
    rmSync(dir, { recursive: true, force: true })
  })

  // A class name is not proof: dispatch reads subcommands/aliases/options
  // at every level, so a value that only answers to the name crashes on
  // the first line an agent types instead of failing the create.
  it('refuses an impostor class named CLISpec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(
      join(dir, 'impostor.mjs'),
      'class CLISpec { constructor() { this.name = "tally" } }\n' +
        'export const TALLY = new CLISpec()\n',
    )
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { tally: { cli: `${join(dir, 'impostor.mjs')}:TALLY` } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/is not a CLISpec/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a tree whose subcommand is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(
      join(dir, 'deep.mjs'),
      'export const TALLY = {name: "tally", aliases: [], options: [],\n' +
        '  subcommands: [{name: "sum", aliases: [], options: []}]}\n',
    )
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { tally: { cli: `${join(dir, 'deep.mjs')}:TALLY` } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/is not a CLISpec/)
    rmSync(dir, { recursive: true, force: true })
  })

  // The rebase must not touch a package specifier: Node resolves it, and
  // scoped and subpath names carry slashes that Python's `/` test would
  // have read as a path.
  it('leaves scoped and subpath specifiers alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(
      join(dir, 'ws.yaml'),
      'mounts:\n  /data:\n    resource: ram\nclis:\n' +
        '  a:\n    cli: "@scope/my-clis:JIRA"\n' +
        '  b:\n    cli: my-clis/specs:JIRA\n',
    )
    const cfg = loadWorkspaceConfigFile(join(dir, 'ws.yaml'))
    expect(cfg.clis?.a?.cli).toBe('@scope/my-clis:JIRA')
    expect(cfg.clis?.b?.cli).toBe('my-clis/specs:JIRA')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports a ref whose file is missing', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { tally: { cli: '/nonexistent/tally.mjs:TALLY' } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/cannot load script/)
  })

  it('reports a ref whose export is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ref-'))
    writeFileSync(join(dir, 'other.mjs'), 'export const OTHER = 1\n')
    const cfg = loadWorkspaceConfig({
      mounts: { '/data': { resource: 'ram' } },
      clis: { tally: { cli: `${join(dir, 'other.mjs')}:TALLY` } },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow(/"TALLY" not found in/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('CLI to daemon round trip', () => {
  it('the shape a CLI sends passes the daemon check unchanged', () => {
    // `workspace create` checks the file client-side (env interpolation
    // needs the user's shell) and POSTs the result; the daemon runs the
    // same check on what arrives. Camelizing before sending would force
    // the loader to accept its own output, and with it the camelCase
    // spellings Python refuses.
    const dir = mkdtempSync(join(tmpdir(), 'mirage-wire-'))
    const file = join(dir, 'w.yaml')
    writeFileSync(
      file,
      [
        'mounts:',
        '  /:',
        '    resource: ram',
        'default_session_id: mysess',
        'cache:',
        '  type: ram',
        '  limit: 256MB',
        '  max_drain_bytes: 1048576',
        '',
      ].join('\n'),
    )
    const wire = checkWorkspaceConfigFile(file)
    expect(Object.keys(wire)).toContain('default_session_id')
    const cfg = loadWorkspaceConfig(wire)
    expect(cfg.defaultSessionId).toBe('mysess')
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebases a profile policy path onto the config dir before loading it', async () => {
    // The check door validates the profile without reading its policy:
    // reading at validation resolved `roles/x.js` against the process
    // cwd (this test's cwd is the package, not the config dir), so
    // checking a file config from anywhere else failed with ENOENT.
    const dir = mkdtempSync(join(tmpdir(), 'mirage-profile-policy-'))
    mkdirSync(join(dir, 'roles'))
    writeFileSync(join(dir, 'roles', 'x.js'), 'function preCommand() { return null }\n')
    const file = join(dir, 'w.yaml')
    writeFileSync(
      file,
      [
        'mounts:',
        '  /data:',
        '    resource: ram',
        'profiles:',
        '  release: {policy: {script: roles/x.js, runtime: quickjs}}',
        '',
      ].join('\n'),
    )
    const wire = checkWorkspaceConfigFile(file)
    const profiles = wire.profiles as Record<string, { policy: Record<string, unknown> }>
    expect(profiles.release?.policy.script).toBe(join(dir, 'roles', 'x.js'))
    const args = await configToWorkspaceArgs(loadWorkspaceConfigFile(file))
    const release = args.options.profiles?.release
    expect(release?.policy?.script).toBeInstanceOf(ScriptSource)
    expect((release?.policy?.script as ScriptSource).source).toBe(
      'function preCommand() { return null }\n',
    )
    expect(release?.policy?.runtime).toBe('quickjs')
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a profile policy that states no runtime', () => {
    // There is no default engine: a policy the config does not pin to
    // an engine is refused at load, not guessed at the gate.
    const dir = mkdtempSync(join(tmpdir(), 'mirage-profile-policy-'))
    const file = join(dir, 'w.yaml')
    writeFileSync(
      file,
      [
        'mounts:',
        '  /data:',
        '    resource: ram',
        'profiles:',
        '  release: {policy: {script: roles/x.js}}',
        '',
      ].join('\n'),
    )
    expect(() => checkWorkspaceConfigFile(file)).toThrow(/runtime names the engine the policy/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('tells a profile written with script and runtime where the keys went', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-profile-policy-'))
    const file = join(dir, 'w.yaml')
    writeFileSync(
      file,
      [
        'mounts:',
        '  /data:',
        '    resource: ram',
        'profiles:',
        '  release: {script: roles/x.js, runtime: quickjs}',
        '',
      ].join('\n'),
    )
    expect(() => checkWorkspaceConfigFile(file)).toThrow(/now one policy block/)
    rmSync(dir, { recursive: true, force: true })
  })
})

// integ/fixtures/config/*.json are the contract: the python suite
// (tests/config/test_loader.py) reads the same files, so a config that
// loads in one language and not the other fails a test until both
// loaders agree. The accepted half is one file per subject: every config
// block that is not a permission verb, then a verb each.
const ACCEPTED_FIXTURES = ['blocks', 'allow', 'ask', 'deny'] as const

function fixtureCases(name: string): { name: string; config: Record<string, unknown> }[] {
  const path = fileURLToPath(
    new URL(`../../../../integ/fixtures/config/${name}.json`, import.meta.url),
  )
  return (
    JSON.parse(readFileSync(path, 'utf8')) as {
      cases: { name: string; config: Record<string, unknown> }[]
    }
  ).cases
}

describe('shared rejection fixture', () => {
  const cases = fixtureCases('rejected')

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('refuses $name', ({ config }) => {
    expect(() => loadWorkspaceConfig(config)).toThrow()
  })
})

describe.each(ACCEPTED_FIXTURES)('shared acceptance fixture: %s', (fixture) => {
  // The key tables are copied by hand from Python's models, so the drift
  // this catches is a field added there and never mirrored here: every
  // key of every block appears in the accepted set, and an unmirrored one
  // comes back as `unknown ... key`.
  const cases = fixtureCases(fixture)

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('accepts $name', ({ config }) => {
    expect(() => loadWorkspaceConfig(config)).not.toThrow()
  })
})

describe('env block', () => {
  it('parses literal and managed entries, ${VAR} interpolated', () => {
    const cfg = loadWorkspaceConfig(
      {
        mounts: { '/data': { resource: 'ram' } },
        env: {
          GREETING: 'hello ${WHO}',
          EDITOR: { value: 'vim', readonly: true, export: false },
          TOKEN: { from: 'aws-sm', ref: 'prod/tokens', key: 'api', fetch: 'eager' },
          HOME_DIR: { from: 'env' },
        },
      },
      { WHO: 'world' },
    )
    expect(cfg.env).toEqual({
      GREETING: 'hello world',
      EDITOR: { value: 'vim', readonly: true, export: false },
      TOKEN: { from: 'aws-sm', ref: 'prod/tokens', key: 'api', fetch: 'eager' },
      HOME_DIR: { from: 'env' },
    })
  })

  it('is absent by default and absent from the workspace args', async () => {
    const cfg = loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } })
    expect(cfg.env).toBeUndefined()
    const args = await configToWorkspaceArgs(cfg)
    expect('env' in args.options).toBe(false)
  })

  it('passes the block through to the workspace options', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      env: { APP: 'integ', T: { from: 'env' } },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.env).toEqual({ APP: 'integ', T: { from: 'env' } })
  })

  it('surfaces entry refusals as config errors naming the variable', () => {
    const base = { mounts: { '/': { resource: 'ram' } } }
    expect(() => loadWorkspaceConfig({ ...base, env: { X: { value: 'v', from: 'env' } } })).toThrow(
      /env\.X.*not both/,
    )
    expect(() =>
      loadWorkspaceConfig({ ...base, env: { X: { from: 'env', export: false } } }),
    ).toThrow(/always exported/)
    expect(() => loadWorkspaceConfig({ ...base, env: { X: { value: 'v', key: 'k' } } })).toThrow(
      /managed entries/,
    )
    expect(() => loadWorkspaceConfig({ ...base, env: { X: 5 } })).toThrow(
      /env\.X.*string or a mapping/,
    )
    expect(() => loadWorkspaceConfig({ ...base, env: 'nope' })).toThrow(/must be a mapping/)
  })
})

describe('the secrets block', () => {
  it('declares instances and keeps their config keys verbatim', () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      secrets: {
        sm: {
          source: 'aws-sm',
          config: { region: 'us-east-2', aws_access_key_id: { from: 'env', key: 'KEY_ID' } },
        },
      },
    })
    expect(cfg.secrets).toEqual({
      sm: {
        source: 'aws-sm',
        config: { region: 'us-east-2', aws_access_key_id: { from: 'env', key: 'KEY_ID' } },
      },
    })
  })

  it('is absent by default', async () => {
    const cfg = loadWorkspaceConfig({ mounts: { '/': { resource: 'ram' } } })
    expect(cfg.secrets).toBeUndefined()
    const args = await configToWorkspaceArgs(cfg)
    expect('secrets' in args.options).toBe(false)
  })

  it('passes the block through to the workspace options', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      secrets: { sm: { source: 'aws-sm', config: { region: 'us-east-2' } } },
    })
    const args = await configToWorkspaceArgs(cfg)
    expect(args.options.secrets).toEqual({
      sm: { source: 'aws-sm', config: { region: 'us-east-2' } },
    })
  })

  it('builds no source when no mount or CLI config names one', async () => {
    // Building a source reads its own bootstrap pointers, and a dotenv
    // file is I/O. With nothing to serve, a source whose file is
    // missing must not stop the workspace from being created: the
    // managed variables that do read it resolve at command time.
    const cfg = loadWorkspaceConfig({
      mounts: { '/': { resource: 'ram' } },
      secrets: {
        sm: {
          source: 'aws-sm',
          config: { region: { from: 'dotenv', ref: '/no/such/file', key: 'R' } },
        },
      },
    })
    await expect(configToWorkspaceArgs(cfg)).resolves.toBeDefined()
  })

  it('builds the source when a mount config does name one', async () => {
    const cfg = loadWorkspaceConfig({
      mounts: {
        '/': { resource: 'ram', config: { root: { from: 'sm', ref: 'r', key: 'K' } } },
      },
      secrets: {
        sm: {
          source: 'aws-sm',
          config: { region: { from: 'dotenv', ref: '/no/such/file', key: 'R' } },
        },
      },
    })
    await expect(configToWorkspaceArgs(cfg)).rejects.toThrow()
  })

  it('surfaces refusals as config errors naming the instance', () => {
    const base = { mounts: { '/': { resource: 'ram' } } }
    expect(() =>
      loadWorkspaceConfig({
        ...base,
        secrets: { sm: { source: 'aws-sm', config: { region: { from: 'aws-sm', key: 'r' } } } },
      }),
    ).toThrow(/secrets\.sm.*needs no config of its own/s)
    expect(() => loadWorkspaceConfig({ ...base, secrets: { sm: { kind: 'aws-sm' } } })).toThrow(
      /secrets\.sm/,
    )
    expect(() => loadWorkspaceConfig({ ...base, secrets: { sm: 5 } })).toThrow(
      /secrets\.sm.*must be a mapping/,
    )
    expect(() => loadWorkspaceConfig({ ...base, secrets: 'nope' })).toThrow(/must be a mapping/)
  })
})

describe('a mount or CLI credential from the secrets plane', () => {
  it('resolves a mount pointer against a declared instance', async () => {
    process.env.CONFIG_DOOR_PROBE = 'xoxb-from-env'
    const args = await configToWorkspaceArgs(
      loadWorkspaceConfig({
        mounts: {
          '/slack': {
            resource: 'slack',
            config: { token: { from: 'ambient', key: 'CONFIG_DOOR_PROBE' } },
          },
        },
        secrets: { ambient: { source: 'env' } },
      }),
    )
    const entry = args.resources['/slack']
    expect(entry).toBeDefined()
    expect(JSON.stringify(entry?.[0])).not.toContain('CONFIG_DOOR_PROBE')
  })

  it('resolves a CLI pointer against the same instances', async () => {
    // The sources reached mount construction and not `buildCliEntries`,
    // so the CLI's config model was handed the pointer itself.
    process.env.CONFIG_DOOR_CLI_PROBE = 'xoxb-for-the-cli'
    const args = await configToWorkspaceArgs(
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        clis: {
          sl: {
            cli: 'slack',
            config: { token: { from: 'ambient', key: 'CONFIG_DOOR_CLI_PROBE' } },
          },
        },
        secrets: { ambient: { source: 'env' } },
      }),
    )
    expect(args.options.clis?.sl).toEqual(['slack', { token: 'xoxb-for-the-cli' }])
  })

  it('resolves a pointer with no secrets block at all', async () => {
    process.env.CONFIG_DOOR_BARE_PROBE = 'xoxb-ambient'
    const args = await configToWorkspaceArgs(
      loadWorkspaceConfig({
        mounts: { '/data': { resource: 'ram' } },
        clis: {
          sl: { cli: 'slack', config: { token: { from: 'env', key: 'CONFIG_DOOR_BARE_PROBE' } } },
        },
      }),
    )
    expect(args.options.clis?.sl).toEqual(['slack', { token: 'xoxb-ambient' }])
  })
})

describe('config interpolation', () => {
  it('keeps a __proto__ key through the walk', () => {
    // The copy walks the whole config, so keyed assignment would drop
    // a `__proto__` source instance or config field before anything
    // downstream saw it.
    const cfg = Object.fromEntries([
      ['__proto__', 'kept'],
      ['plain', 'v'],
    ])
    const out = interpolateEnv(cfg, {})
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect((out as Record<string, unknown>).__proto__).toBe('kept')
  })
})
