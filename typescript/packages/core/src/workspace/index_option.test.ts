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

import { describe, expect, it, vi } from 'vitest'
import * as indexFactory from '../cache/index/factory.ts'
import { type IndexConfig, IndexType, type RedisIndexConfig } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { MountMode, ReadPolicy, type ReadSpec } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Mount } from './mount/spec.ts'
import { Workspace } from './workspace/workspace.ts'

describe('Workspace index option', () => {
  it('applies the workspace index config to mounts', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/data': ram }, { index: { type: IndexType.RAM, ttl: 5 } })
    const index = ws.mount('/data').indexStore
    expect(index).toBeInstanceOf(RAMIndexCacheStore)
    expect(index.ttl).toBe(5)
    await ws.close()
  })

  it('keeps the VFS default index when no workspace index is given', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/data': ram }, {})
    expect(ws.mount('/data').indexStore.ttl).toBe(0)
    await ws.close()
  })

  it('lets a mount placement win over the workspace index config', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace(
      { '/data': new Mount(ram, { index: { type: IndexType.RAM, ttl: 7 } }) },
      { index: { type: IndexType.RAM, ttl: 5 } },
    )
    expect(ws.mount('/data').indexStore.ttl).toBe(7)
    await ws.close()
  })

  it('takes the snake_case spelling of a workspace index field', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        index: {
          type: IndexType.REDIS,
          url: 'redis://127.0.0.1:1/0',
          key_prefix: 't1:',
        } as IndexConfig,
      },
    )
    expect((ws.mount('/data').indexConfig as RedisIndexConfig).keyPrefix).toBe('t1:')
    await ws.close()
  })

  it('takes the snake_case spelling of a per-mount index field', async () => {
    const index = {
      type: IndexType.REDIS,
      url: 'redis://127.0.0.1:1/0',
      key_prefix: 't2:',
    } as IndexConfig
    const ws = new Workspace({ '/data': new Mount(new RAMVFS(), { index }) })
    expect((ws.mount('/data').indexConfig as RedisIndexConfig).keyPrefix).toBe('t2:')
    await ws.close()
  })

  it('refuses an unknown workspace index field', () => {
    expect(
      () => new Workspace({ '/data': new RAMVFS() }, { index: { ttll: 5 } as IndexConfig }),
    ).toThrow(/"ttll"/)
  })

  // Both checks would refuse this; the first one ends construction, and the
  // caller should be told about the typo rather than the bound it never reached.
  it('names an unknown workspace index field before judging the read policy', () => {
    expect(
      () =>
        new Workspace(
          { '/data': new Mount(new RAMVFS(), { read: { policy: ReadPolicy.BOUNDED, ttl: 0 } }) },
          { index: { ttll: 5 } as IndexConfig },
        ),
    ).toThrow(/"ttll"/)
  })

  it('gives a mount added later the snake_case workspace index field', async () => {
    const ws = new Workspace(
      {},
      {
        index: {
          type: IndexType.REDIS,
          url: 'redis://127.0.0.1:1/0',
          key_prefix: 't3:',
        } as IndexConfig,
      },
    )
    ws.addMount('/late', new RAMVFS())
    expect((ws.mount('/late').indexConfig as RedisIndexConfig).keyPrefix).toBe('t3:')
    await ws.close()
  })

  // RAM keeps no listings of its own (indexTtl 0), so these only pass on
  // the index the call names: 37 rather than the workspace's 73, and
  // fresh accepted on 30 or refused on 0 where the workspace says 73.
  it('runs an added mount under the index it names', async () => {
    const ws = new Workspace({}, { index: { type: IndexType.RAM, ttl: 73 } })
    try {
      const entry = ws.addMount('/b', new RAMVFS(), MountMode.READ, undefined, null, {
        type: IndexType.RAM,
        ttl: 37,
      })
      expect(entry.indexStore.ttl).toBe(37)
      expect(entry.indexConfig).toEqual({ type: IndexType.RAM, ttl: 37 })
    } finally {
      await ws.close()
    }
  })

  it('judges an added mount on the index it names', async () => {
    const fresh: ReadSpec = { policy: ReadPolicy.FRESH, ttl: 600 }
    const bare = new Workspace({})
    try {
      const entry = bare.addMount('/r', new RAMVFS(), MountMode.READ, fresh, null, { ttl: 30 })
      expect(entry.read.policy).toBe(ReadPolicy.FRESH)
    } finally {
      await bare.close()
    }
    const ws = new Workspace({}, { index: { ttl: 73 } })
    try {
      expect(() =>
        ws.addMount('/d', new RAMVFS(), MountMode.READ, fresh, null, { ttl: 0 }),
      ).toThrow(/'\/d'.*caches reads or listings/)
    } finally {
      await ws.close()
    }
  })

  it('builds no index store for a refused added mount', async () => {
    const ws = new Workspace({})
    const built = vi.spyOn(indexFactory, 'buildIndex')
    try {
      expect(() =>
        ws.addMount('/d', new RAMVFS(), MountMode.READ, { policy: ReadPolicy.FRESH, ttl: 600 }, null, {
          type: IndexType.REDIS,
          url: 'redis://127.0.0.1:1/0',
          ttl: 0,
        } as RedisIndexConfig),
      ).toThrow(/caches reads or listings/)
      // The verdict runs before the registry builds a store, so a refused
      // call leaves no Redis client behind and no mount.
      expect(built).not.toHaveBeenCalled()
      expect(ws.mounts().some((m) => m.prefix === '/d/')).toBe(false)
    } finally {
      built.mockRestore()
      await ws.close()
    }
  })

  // Two mounts of one instance run one store, the first one's: the rule
  // the constructor applies, so an alias's own index goes unused and fresh
  // is judged on the store it shares.
  it('shares the first mount index with an added alias', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/a': new Mount(ram, { index: { ttl: 37 } }) })
    try {
      const alias = ws.addMount('/b', ram, MountMode.READ, undefined, null, { ttl: 0 })
      expect(alias.indexStore).toBe(ws.mount('/a').indexStore)
      expect(alias.indexConfig?.ttl).toBe(37)
      const judged = ws.addMount(
        '/c',
        ram,
        MountMode.READ,
        { policy: ReadPolicy.FRESH, ttl: 600 },
        null,
        { ttl: 0 },
      )
      expect(judged.read.policy).toBe(ReadPolicy.FRESH)
    } finally {
      await ws.close()
    }
  })

  it('names a typo in an added mount index before the read policy, alias or not', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/a': ram })
    const banana = { policy: 'banana', ttl: 600 } as unknown as ReadSpec
    try {
      for (const vfs of [new RAMVFS(), ram]) {
        expect(() =>
          ws.addMount('/b', vfs, MountMode.READ, banana, null, { ttll: 5 } as IndexConfig),
        ).toThrow(/"ttll"/)
      }
    } finally {
      await ws.close()
    }
  })

  it('takes the snake_case spelling of an added mount index field', async () => {
    const ws = new Workspace({})
    try {
      const entry = ws.addMount('/late', new RAMVFS(), MountMode.READ, undefined, null, {
        type: IndexType.REDIS,
        url: 'redis://127.0.0.1:1/0',
        key_prefix: 't4:',
      } as IndexConfig)
      expect((entry.indexConfig as RedisIndexConfig).keyPrefix).toBe('t4:')
    } finally {
      await ws.close()
    }
  })
})
