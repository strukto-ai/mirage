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
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { Workspace } from '../../../workspace.ts'
import { RedisNamespaceStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function makeStore(prefix: string, table = 'nodes'): RedisNamespaceStore {
  return REDIS_URL !== undefined
    ? new RedisNamespaceStore({ url: REDIS_URL, keyPrefix: prefix, table })
    : new RedisNamespaceStore({ keyPrefix: prefix, table })
}

function testPrefix(): string {
  return `mirage:test:namespace:${randomUUID().slice(0, 8)}:`
}

// Read-modify-CAS one counter, retrying until each round lands.
async function casIncrement(
  store: RedisNamespaceStore,
  worker: string,
  rounds: number,
): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    let landed = false
    for (let attempt = 0; attempt < 200 && !landed; attempt++) {
      const record = (await store.load()).get('hot') ?? { session_id: 'hot', env: {} }
      const env = { ...((record.env ?? {}) as Record<string, string>) }
      env[worker] = String(Number(env[worker] ?? '0') + 1)
      const expected = Number(record.generation ?? 0)
      landed = await store.casSet('hot', { ...record, env, generation: expected + 1 }, expected)
    }
    if (!landed) throw new Error('cas retry budget exhausted')
  }
}

class OverlayRAMVFS extends RAMVFS {
  static {
    // No setattr of its own, as an API backend with no attribute slot:
    // attrs land in the namespace overlay.
    Object.defineProperty(
      this.prototype,
      'setattr',
      Object.getOwnPropertyDescriptor(BaseVFS.prototype, 'setattr') ?? {},
    )
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
      { '/data': new OverlayRAMVFS() },
      { mode: MountMode.WRITE, namespaceStore: makeStore(prefix) },
    )
    await ws.shell('echo alpha > /data/f.txt')
    await ws.shell('chmod 601 /data/f.txt && chown 500:dev /data/f.txt')
    await ws.shell('ln -s /data/f.txt /data/link')
    await ws.close()

    const reborn = new Workspace(
      { '/data': new OverlayRAMVFS() },
      { mode: MountMode.WRITE, namespaceStore: makeStore(prefix) },
    )
    await reborn.shell('echo alpha > /data/f.txt')
    const st = (await reborn.dispatch('stat', '/data/f.txt')) as FileStat
    expect(st.mode).toBe(0o601)
    expect(st.uid).toBe(500)
    expect(st.gid).toBe('dev')
    const r = await reborn.shell('readlink /data/link')
    expect(r.stdoutText).toBe('/data/f.txt\n')
    const cleaner = makeStore(prefix)
    await cleaner.clear()
    await cleaner.close()
    await reborn.close()
  })
})

describe.skipIf(skip)('RedisNamespaceStore casSet', () => {
  it('serializes two writers on the generation counter', async () => {
    const prefix = testPrefix()
    const writerA = makeStore(prefix)
    const writerB = makeStore(prefix)
    try {
      expect(await writerA.casSet('s', { session_id: 's', cwd: '/a', generation: 1 }, 0)).toBe(true)
      expect(await writerB.casSet('s', { session_id: 's', cwd: '/b', generation: 1 }, 0)).toBe(
        false,
      )
      expect(await writerB.casSet('s', { session_id: 's', cwd: '/b', generation: 2 }, 1)).toBe(true)
      expect((await writerA.load()).get('s')?.cwd).toBe('/b')
    } finally {
      await writerA.clear()
      await writerA.close()
      await writerB.close()
    }
  })

  it('concurrent writers lose no updates', async () => {
    const store = makeStore(testPrefix())
    try {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => casIncrement(store, `w${String(i)}`, 10)),
      )
      const final = (await store.load()).get('hot')
      expect(final?.generation).toBe(50)
      expect(final?.env).toEqual(
        Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`w${String(i)}`, '10'])),
      )
    } finally {
      await store.clear()
      await store.close()
    }
  })

  it('treats a legacy record without the field as generation 0', async () => {
    const store = makeStore(testPrefix())
    try {
      await store.set('s1', { session_id: 's1', cwd: '/old' })
      expect(await store.casSet('s1', { session_id: 's1', cwd: '/new', generation: 1 }, 0)).toBe(
        true,
      )
      expect((await store.load()).get('s1')?.cwd).toBe('/new')
    } finally {
      await store.clear()
      await store.close()
    }
  })

  it('shares sessions across workspaces on the same table', async () => {
    const prefix = testPrefix()
    const storeA = makeStore(prefix, 'sessions')
    const storeB = makeStore(prefix, 'sessions')
    const wsA = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, sessionStore: storeA },
    )
    const wsB = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, sessionStore: storeB },
    )
    try {
      wsA.createSession('narrow', { mounts: { '/data': 'read' } })
      await wsA.flushSessions()
      await wsB.ensureSessionsLoaded()
      const session = wsB.getSession('narrow')
      expect(session.mountModes).not.toBeNull()
      expect(session.mountModes?.get('/data')).toBe(MountMode.READ)
    } finally {
      await storeA.clear()
      await wsA.close()
      await wsB.close()
    }
  })
})
