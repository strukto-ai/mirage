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

import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordNamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import { DiskRecordClient } from './disk.ts'

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, open: vi.fn(real.open) }
})

it('releases the lock and handle when writing the owner fails', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mirage-record-'))
  try {
    const client = new DiskRecordClient(root, '')
    const lock = `${client.path('record')}.lock`
    const handle = await fs.open(lock, 'wx')
    vi.spyOn(handle, 'write').mockRejectedValueOnce(new Error('write failed'))
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    await expect(client.lock('record')).rejects.toThrow('write failed')
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
    await client.unlock('record', await client.lock('record'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function casIncrement(store: RecordNamespaceStore, worker: string, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    let landed = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const record = (await store.load()).get('hot') ?? { session_id: 'hot', env: {} }
      const env = { ...(record.env as Record<string, string> | undefined) }
      env[worker] = String(parseInt(env[worker] ?? '0', 10) + 1)
      const expected = (record.generation as number | undefined) ?? 0
      const fields = { ...record, env, generation: expected + 1 }
      if (await store.casSet('hot', fields, expected)) {
        landed = true
        break
      }
      await new Promise((r) => setTimeout(r, 0))
    }
    if (!landed) throw new Error('cas retry budget exhausted')
  }
}

describe('RecordNamespaceStore over DiskRecordClient', () => {
  let root: string
  let store: RecordNamespaceStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mir-disk-'))
    store = new RecordNamespaceStore(new DiskRecordClient(root, 'sessions/'))
  })
  afterEach(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips set and load', async () => {
    await store.set('s1', { session_id: 's1', cwd: '/a', env: {} })
    await store.set('s2', { session_id: 's2', mount_modes: { '/data': 'read' } })
    const entries = await store.load()
    expect(entries.get('s1')?.cwd).toBe('/a')
    expect(entries.get('s2')?.mount_modes).toEqual({ '/data': 'read' })
  })

  it('deletes, replaces all, and clears', async () => {
    await store.set('a', { session_id: 'a' })
    await store.set('b', { session_id: 'b' })
    await store.delete(['a', 'missing'])
    expect([...(await store.load()).keys()]).toEqual(['b'])
    await store.replaceAll(new Map([['c', { session_id: 'c' }]]))
    expect([...(await store.load()).keys()]).toEqual(['c'])
    await store.clear()
    expect((await store.load()).size).toBe(0)
  })

  it('cas creates only once', async () => {
    const first = { session_id: 's', generation: 1 }
    expect(await store.casSet('s', first, 0)).toBe(true)
    expect(await store.casSet('s', { session_id: 's', generation: 1 }, 0)).toBe(false)
    const stored = JSON.parse(readFileSync(join(root, 'sessions', 's.json')).toString()) as unknown
    expect(stored).toEqual(first)
  })

  it('cas rejects a stale generation', async () => {
    await store.set('s', { session_id: 's', generation: 2 })
    expect(await store.casSet('s', { session_id: 's', generation: 2 }, 1)).toBe(false)
    expect(await store.casSet('s', { session_id: 's', cwd: '/x', generation: 3 }, 2)).toBe(true)
    expect((await store.load()).get('s')?.cwd).toBe('/x')
  })

  it('counts a legacy record without the field as generation zero', async () => {
    await store.set('s', { session_id: 's' })
    expect(await store.casSet('s', { session_id: 's', generation: 1 }, 0)).toBe(true)
  })

  it('loses to a live lock and wins after release', async () => {
    await store.set('s', { session_id: 's', generation: 1 })
    const lock = join(root, 'sessions', 's.json.lock')
    writeFileSync(lock, '9999999')
    expect(await store.casSet('s', { session_id: 's', generation: 2 }, 1)).toBe(false)
    rmSync(lock)
    expect(await store.casSet('s', { session_id: 's', generation: 2 }, 1)).toBe(true)
  })

  it('reclaims a stale lock', async () => {
    await store.set('s', { session_id: 's', generation: 1 })
    const lock = join(root, 'sessions', 's.json.lock')
    writeFileSync(lock, '424242')
    const old = (Date.now() - 100_000) / 1000
    utimesSync(lock, old, old)
    expect(await store.casSet('s', { session_id: 's', generation: 2 }, 1)).toBe(true)
    expect(readdirSync(join(root, 'sessions'))).toEqual(['s.json'])
  })

  it('quotes ids with slashes into one file, matching Python', async () => {
    await store.set('a/b', { session_id: 'a/b' })
    expect([...(await store.load()).keys()]).toEqual(['a/b'])
    expect(readdirSync(join(root, 'sessions'))).toEqual(['a%2Fb.json'])
  })

  it('leaves no tmp or lock files behind', async () => {
    await store.set('s', { session_id: 's' })
    expect(await store.casSet('s', { session_id: 's', generation: 1 }, 0)).toBe(true)
    expect(await store.casSet('s', { session_id: 's', generation: 1 }, 0)).toBe(false)
    const leftovers = readdirSync(join(root, 'sessions')).filter((n) => !n.endsWith('.json'))
    expect(leftovers).toEqual([])
  })

  it('loses nothing across concurrent CAS writers', async () => {
    const workers = ['w0', 'w1', 'w2', 'w3', 'w4']
    await Promise.all(workers.map((w) => casIncrement(store, w, 5)))
    const record = (await store.load()).get('hot')
    expect(record?.generation).toBe(25)
    for (const w of workers) {
      expect((record?.env as Record<string, string>)[w]).toBe('5')
    }
  })
})
