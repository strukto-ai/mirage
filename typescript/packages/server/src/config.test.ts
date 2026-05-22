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
})
