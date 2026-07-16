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
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from '../../workspace.ts'
import { RedisSessionStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function makeStore(prefix: string): RedisSessionStore {
  return REDIS_URL !== undefined
    ? new RedisSessionStore({ url: REDIS_URL, keyPrefix: prefix })
    : new RedisSessionStore({ keyPrefix: prefix })
}

function testPrefix(): string {
  return `mirage:test:session:${randomUUID().slice(0, 8)}:`
}

describe.skipIf(skip)('RedisSessionStore', () => {
  it('set/load roundtrip', async () => {
    const store = makeStore(testPrefix())
    try {
      await store.set('s1', { session_id: 's1', cwd: '/a', env: {} })
      await store.set('s2', {
        session_id: 's2',
        cwd: '/',
        env: { K: 'v' },
        mount_modes: { '/data': 'read' },
      })
      const entries = await store.load()
      expect(entries.get('s1')?.cwd).toBe('/a')
      expect(entries.get('s2')?.mount_modes).toEqual({ '/data': 'read' })
    } finally {
      await store.clear()
      await store.close()
    }
  })

  it('delete and replaceAll', async () => {
    const store = makeStore(testPrefix())
    try {
      await store.set('a', { session_id: 'a' })
      await store.set('b', { session_id: 'b' })
      await store.delete(['a', 'missing'])
      expect([...(await store.load()).keys()]).toEqual(['b'])
      await store.replaceAll(new Map([['c', { session_id: 'c' }]]))
      expect([...(await store.load()).keys()]).toEqual(['c'])
    } finally {
      await store.clear()
      await store.close()
    }
  })

  it('sessions are shared across workspaces on the same prefix', async () => {
    const prefix = testPrefix()
    const storeA = makeStore(prefix)
    const storeB = makeStore(prefix)
    const wsA = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.EXEC, sessionStore: storeA },
    )
    const wsB = new Workspace(
      { '/data': new RAMResource() },
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
