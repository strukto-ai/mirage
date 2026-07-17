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
import { createClient } from 'redis'
import { describe, expect, it } from 'vitest'
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from '../../workspace.ts'
import { RedisWorkspaceStateStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function makeStore(prefix: string): RedisWorkspaceStateStore {
  return REDIS_URL !== undefined
    ? new RedisWorkspaceStateStore({ url: REDIS_URL, keyPrefix: prefix })
    : new RedisWorkspaceStateStore({ keyPrefix: prefix })
}

function testPrefix(): string {
  return `mirage:test:wsstore:${randomUUID().slice(0, 8)}:`
}

async function cleanup(prefix: string): Promise<void> {
  if (REDIS_URL === undefined) return
  const c = createClient({ url: REDIS_URL })
  await c.connect()
  const keys: string[] = []
  for await (const key of c.scanIterator({ MATCH: `${prefix}*` })) {
    keys.push(...(Array.isArray(key) ? key : [key]))
  }
  if (keys.length > 0) await c.del(keys)
  await c.quit()
}

describe.skipIf(skip)('RedisWorkspaceStateStore', () => {
  it('scopes keys by workspace id', async () => {
    const prefix = testPrefix()
    const store = makeStore(prefix)
    try {
      await store.sessions('ws1').set('s1', { session_id: 's1' })
      await store.namespace('ws1').set('/a', { mode: 0o600 })
      await store.setMeta('ws1', { workspace_id: 'ws1' })
      const c = createClient({ url: REDIS_URL ?? 'redis://localhost:6379/0' })
      await c.connect()
      const keys = new Set<string>()
      for await (const key of c.scanIterator({ MATCH: `${prefix}*` })) {
        for (const k of Array.isArray(key) ? key : [key]) keys.add(k)
      }
      await c.quit()
      expect(keys.has(`${prefix}ws1:sessions`)).toBe(true)
      expect(keys.has(`${prefix}ws1:namespace:nodes`)).toBe(true)
      expect(keys.has(`${prefix}workspaces`)).toBe(true)
    } finally {
      await cleanup(prefix)
      await store.close()
    }
  })

  it('meta is visible across providers', async () => {
    const prefix = testPrefix()
    const storeA = makeStore(prefix)
    const storeB = makeStore(prefix)
    try {
      await storeA.setMeta('ws1', { workspace_id: 'ws1', default_session_id: 'default' })
      const meta = await storeB.loadMeta('ws1')
      expect(meta?.default_session_id).toBe('default')
      expect(await storeB.loadMeta('other')).toBeNull()
    } finally {
      await cleanup(prefix)
      await storeA.close()
      await storeB.close()
    }
  })

  it('a sibling process discovers the workspace and reads its sessions', async () => {
    const prefix = testPrefix()
    const storeA = makeStore(prefix)
    const storeB = makeStore(prefix)
    const ws = new Workspace(
      { '/data': new RAMResource() },
      { mode: MountMode.EXEC, workspaceId: 'agent-ws', store: storeA },
    )
    try {
      ws.createSession('narrow', { mounts: { '/data': 'read' } })
      await ws.ensureSessionsLoaded()
      await ws.flushSessions()

      const meta = await storeB.loadMeta('agent-ws')
      expect(meta?.default_session_id).toBe(ws.defaultSessionId)
      const sessions = await storeB.sessions('agent-ws').load()
      const narrow = sessions.get('narrow') as { mount_modes?: Record<string, string> }
      expect(narrow.mount_modes?.['/data']).toBe('read')
    } finally {
      await ws.close()
      await cleanup(prefix)
      await storeA.close()
      await storeB.close()
    }
  })
})
