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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as s3ClientModule from '../../core/s3/_client.ts'
import type { S3Config } from '../../resource/s3/config.ts'
import { currentFakeS3, installFakeS3 } from '../fixtures/s3_fake.ts'
import { RAMWorkspaceStateStore } from './ram.ts'
import { S3WorkspaceStateStore } from './s3.ts'

vi.mock('../../core/s3/_client.ts', async (importOriginal) => {
  const original = await importOriginal<typeof s3ClientModule>()
  const fake = await import('../fixtures/s3_fake.ts')
  return {
    ...original,
    createS3Client: () => Promise.resolve(fake.currentFakeS3() as never),
    loadS3Module: () => Promise.resolve(fake.FAKE_S3_MODULE),
  }
})

const BUCKET = 'state-bucket'

function config(): S3Config {
  return {
    bucket: BUCKET,
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
    keyPrefix: 'mirage/',
  }
}

describe('S3WorkspaceStateStore', () => {
  beforeEach(() => {
    installFakeS3()
  })

  it('round-trips the meta record at the documented layout', async () => {
    const store = new S3WorkspaceStateStore(config())
    expect(await store.loadMeta('ws1')).toBeNull()
    await store.setMeta('ws1', { workspace_id: 'ws1', default_session_id: 'main' })
    const meta = await store.loadMeta('ws1')
    await store.close()
    expect(meta).toEqual({ workspace_id: 'ws1', default_session_id: 'main' })
    expect(currentFakeS3().entry(BUCKET, 'mirage/workspaces/ws1.json')).toBeDefined()
  })

  it('conditional create admits exactly one winner', async () => {
    const storeA = new S3WorkspaceStateStore(config())
    const storeB = new S3WorkspaceStateStore(config())
    const record = { workspace_id: 'ws1', generation: 1 }
    const results = await Promise.all([
      storeA.casSetMeta('ws1', record, 0),
      storeB.casSetMeta('ws1', { ...record }, 0),
    ])
    await storeA.close()
    await storeB.close()
    expect([...results].sort()).toEqual([false, true])
  })

  it('replaceMeta merges over the stored record and bumps the generation', async () => {
    const store = new S3WorkspaceStateStore(config())
    await store.setMeta('ws1', { workspace_id: 'ws1', created_at: 111, generation: 4 })
    const written = await store.replaceMeta('ws1', {
      workspace_id: 'ws1',
      default_session_id: 'restored',
    })
    await store.close()
    expect(written.default_session_id).toBe('restored')
    expect(written.created_at).toBe(111)
    expect(written.generation).toBe(5)
  })

  it('scopes the session table per workspace and caches it', async () => {
    const store = new S3WorkspaceStateStore(config())
    const sessions = store.sessions('ws1')
    expect(store.sessions('ws1')).toBe(sessions)
    await sessions.set('main', { session_id: 'main' })
    await store.close()
    expect(currentFakeS3().entry(BUCKET, 'mirage/ws1/sessions/main.json')).toBeDefined()
  })

  it('refuses the namespace and observer planes', async () => {
    const store = new S3WorkspaceStateStore(config())
    expect(() => store.namespace('ws1')).toThrow(/sessions\+meta group/)
    expect(() => store.observer('ws1')).toThrow(/sessions\+meta group/)
    await store.close()
  })

  it('serves the workspace group override of a RAM default store', async () => {
    const s3Store = new S3WorkspaceStateStore(config())
    const store = new RAMWorkspaceStateStore({ workspace: s3Store })
    store.namespace('ws1')
    store.observer('ws1')
    await store.sessions('ws1').set('main', { session_id: 'main' })
    await store.setMeta('ws1', { workspace_id: 'ws1' })
    await store.close()
    expect(currentFakeS3().entry(BUCKET, 'mirage/ws1/sessions/main.json')).toBeDefined()
    expect(currentFakeS3().entry(BUCKET, 'mirage/workspaces/ws1.json')).toBeDefined()
  })
})
