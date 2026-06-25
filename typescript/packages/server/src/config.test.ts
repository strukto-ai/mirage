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

import { RedisFileCacheStore } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { interpolateEnv, loadWorkspaceConfig, configToWorkspaceArgs } from './config.ts'

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
