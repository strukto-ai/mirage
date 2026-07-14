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

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { FileStat, RegisteredOp } from '@struktoai/mirage-core'
import { MountMode, OpsRegistry, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from '../../workspace.ts'
import { RedisNamespaceStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function makeStore(prefix: string): RedisNamespaceStore {
  return REDIS_URL !== undefined
    ? new RedisNamespaceStore({ url: REDIS_URL, keyPrefix: prefix })
    : new RedisNamespaceStore({ keyPrefix: prefix })
}

// Ops resolve by resource kind in the workspace registry, so blocking
// setattr registration simulates an API backend with no attribute slot
// (attrs land in the namespace overlay).
class NoSetattrRegistry extends OpsRegistry {
  override register(ro: RegisteredOp): void {
    if (ro.name === 'setattr') return
    super.register(ro)
  }
}

describe.skipIf(skip)('RedisNamespaceStore', () => {
  it('set/load/delete/replaceAll/clear roundtrip', async () => {
    const store = makeStore(`mirage:test:namespace:${randomUUID().slice(0, 8)}:`)
    await store.set('/data/f.txt', { mode: 0o601, uid: 500 })
    await store.set('/data/link', { target: '/t1', mtime: 1 })
    let entries = await store.load()
    expect(entries.get('/data/f.txt')).toEqual({ mode: 0o601, uid: 500 })
    expect(entries.get('/data/link')).toEqual({ target: '/t1', mtime: 1 })
    await store.delete(['/data/f.txt', '/missing'])
    entries = await store.load()
    expect(entries.get('/data/f.txt')).toBeUndefined()
    expect(entries.size).toBe(1)
    await store.replaceAll(new Map([['/c', { mode: 3 }]]))
    expect(await store.load()).toEqual(new Map([['/c', { mode: 3 }]]))
    await store.replaceAll(new Map())
    expect((await store.load()).size).toBe(0)
    await store.set('/a', { mode: 1 })
    await store.clear()
    expect((await store.load()).size).toBe(0)
    await store.close()
  })

  it('namespace state survives a workspace restart', async () => {
    const prefix = `mirage:test:namespace:${randomUUID().slice(0, 8)}:`
    const ws = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.WRITE, ops: new NoSetattrRegistry(), namespaceStore: makeStore(prefix) },
    )
    await ws.execute('echo alpha > /data/f.txt')
    await ws.execute('chmod 601 /data/f.txt && chown 500:dev /data/f.txt')
    await ws.execute('ln -s /data/f.txt /data/link')
    await ws.close()

    const reborn = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.WRITE, ops: new NoSetattrRegistry(), namespaceStore: makeStore(prefix) },
    )
    await reborn.execute('echo alpha > /data/f.txt')
    const st = (await reborn.dispatch('stat', '/data/f.txt')) as FileStat
    expect(st.mode).toBe(0o601)
    expect(st.uid).toBe(500)
    expect(st.gid).toBe('dev')
    const r = await reborn.execute('readlink /data/link')
    expect(r.stdoutText).toBe('/data/f.txt\n')
    const cleaner = makeStore(prefix)
    await cleaner.clear()
    await cleaner.close()
    await reborn.close()
  })
})
