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
import { FakeConditionalS3Client, currentFakeS3, installFakeS3 } from '../fixtures/s3_fake.ts'
import { S3SessionStore } from './s3.ts'
import type { SessionFields } from './store.ts'

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
    keyPrefix: 'mirage/ws1/',
  }
}

async function casIncrement(store: S3SessionStore, worker: string, rounds: number): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    let landed = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const record = (await store.load()).get('hot') ?? { session_id: 'hot', env: {} }
      const env = { ...(record.env as Record<string, string>) }
      env[worker] = String(Number(env[worker] ?? '0') + 1)
      const expected = Number(record.generation ?? 0)
      const fields: SessionFields = { ...record, env, generation: expected + 1 }
      if (await store.casSet('hot', fields, expected)) {
        landed = true
        break
      }
      await Promise.resolve()
    }
    if (!landed) throw new Error('cas retry budget exhausted')
  }
}

describe('S3SessionStore', () => {
  beforeEach(() => {
    installFakeS3()
  })

  it('round-trips set/load and writes the documented layout', async () => {
    const store = new S3SessionStore(config())
    await store.set('s1', { session_id: 's1', cwd: '/a', env: {} })
    await store.set('s2', {
      session_id: 's2',
      cwd: '/',
      env: { K: 'v' },
      mount_modes: { '/data': 'read' },
    })
    const entries = await store.load()
    await store.close()
    expect(entries.get('s1')?.cwd).toBe('/a')
    expect(entries.get('s2')?.mount_modes).toEqual({ '/data': 'read' })
    expect(currentFakeS3().entry(BUCKET, 'mirage/ws1/sessions/s1.json')).toBeDefined()
  })

  it('deletes, replaces all, and clears', async () => {
    const store = new S3SessionStore(config())
    await store.set('a', { session_id: 'a' })
    await store.set('b', { session_id: 'b' })
    await store.delete(['a', 'missing'])
    expect([...(await store.load()).keys()]).toEqual(['b'])
    await store.replaceAll(new Map([['c', { session_id: 'c' }]]))
    expect([...(await store.load()).keys()]).toEqual(['c'])
    await store.clear()
    expect((await store.load()).size).toBe(0)
    await store.close()
  })

  it('cas create lands exactly once', async () => {
    const store = new S3SessionStore(config())
    const first = { session_id: 's', generation: 1 }
    expect(await store.casSet('s', first, 0)).toBe(true)
    expect(await store.casSet('s', { session_id: 's', generation: 1 }, 0)).toBe(false)
    await store.close()
    const stored = currentFakeS3().entry(BUCKET, 'mirage/ws1/sessions/s.json')
    expect(JSON.parse(stored ?? '')).toEqual(first)
  })

  it('rejects a stale generation and accepts the current one', async () => {
    const store = new S3SessionStore(config())
    await store.set('s', { session_id: 's', generation: 2 })
    expect(await store.casSet('s', { session_id: 's', generation: 2 }, 1)).toBe(false)
    expect(await store.casSet('s', { session_id: 's', cwd: '/x', generation: 3 }, 2)).toBe(true)
    const entries = await store.load()
    await store.close()
    expect(entries.get('s')?.cwd).toBe('/x')
  })

  it('treats a legacy record without generation as generation 0', async () => {
    const store = new S3SessionStore(config())
    await store.set('s', { session_id: 's' })
    expect(await store.casSet('s', { session_id: 's', generation: 1 }, 0)).toBe(true)
    await store.close()
  })

  it('detects a write racing between compare-read and conditional put', async () => {
    class RaceOnceClient extends FakeConditionalS3Client {
      raced = true

      protected override async getObject(
        input: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        const response = await super.getObject(input)
        if (!this.raced) {
          this.raced = true
          this.setEntry(
            input.Bucket as string,
            input.Key as string,
            JSON.stringify({ session_id: 's', cwd: '/winner', generation: 2 }),
          )
        }
        return response
      }
    }
    const client = installFakeS3(new RaceOnceClient()) as RaceOnceClient
    const store = new S3SessionStore(config())
    await store.set('s', { session_id: 's', generation: 1 })
    client.raced = false
    expect(await store.casSet('s', { session_id: 's', cwd: '/loser', generation: 2 }, 1)).toBe(
      false,
    )
    const entries = await store.load()
    await store.close()
    expect(entries.get('s')?.cwd).toBe('/winner')
  })

  it('loses nothing under concurrent cas writers', async () => {
    const store = new S3SessionStore(config())
    const workers = ['w0', 'w1', 'w2', 'w3', 'w4']
    await Promise.all(workers.map((worker) => casIncrement(store, worker, 5)))
    const record = (await store.load()).get('hot')
    await store.close()
    expect(record?.generation).toBe(25)
    for (const worker of workers) {
      expect((record?.env as Record<string, string>)[worker]).toBe('5')
    }
  })
})
