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

import { describe, expect, it } from 'vitest'
import { type IndexConfig, IndexType, type RedisIndexConfig } from '../cache/index/config.ts'
import { RAMIndexCacheStore } from '../cache/index/ram.ts'
import { ReadPolicy } from '../types.ts'
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

  it('gives every mount the snake_case spelling of a workspace index field', async () => {
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
    ws.addMount('/late', new RAMVFS())
    expect((ws.mount('/data').indexConfig as RedisIndexConfig).keyPrefix).toBe('t1:')
    expect((ws.mount('/late').indexConfig as RedisIndexConfig).keyPrefix).toBe('t1:')
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
})
