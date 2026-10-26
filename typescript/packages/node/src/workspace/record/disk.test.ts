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
  return {
    ...real,
    open: vi.fn(real.open),
    rename: vi.fn(real.rename),
    stat: vi.fn(real.stat),
    unlink: vi.fn(real.unlink),
  }
})

const real = await vi.importActual<typeof fs>('node:fs/promises')

afterEach(() => {
  vi.mocked(fs.open).mockImplementation(real.open)
  vi.mocked(fs.rename).mockImplementation(real.rename)
  vi.mocked(fs.stat).mockImplementation(real.stat)
  vi.mocked(fs.unlink).mockImplementation(real.unlink)
})

type LateStep = 'unlink' | 'open'
const LATE_STEPS: [string, LateStep][] = [
  ['together', 'unlink'],
  ['after', 'open'],
]

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Hold the first two stats of `lock` until both have run, then delay the
// later waiter's `lateStep`: its unlink of the lock (both reclaim at
// once) or its open of the reclaim guard (it reclaims after the earlier
// waiter has taken a new lock).
function raceTwoReclaimers(lock: string, lateStep: LateStep): void {
  let stats = 0
  let lateCalls = 0
  let bothSawIt: () => void = () => undefined
  const together = new Promise<void>((resolve) => {
    bothSawIt = resolve
  })
  vi.mocked(fs.stat).mockImplementation((async (p: string, opts?: { bigint?: boolean }) => {
    const result = await real.stat(p, opts)
    if (p === lock && stats < 2) {
      stats += 1
      if (stats === 2) bothSawIt()
      await together
    }
    return result
  }) as typeof fs.stat)
  if (lateStep === 'unlink') {
    vi.mocked(fs.unlink).mockImplementation(async (p) => {
      if (p === lock && lateCalls++ === 1) await pause(200)
      await real.unlink(p)
    })
  } else {
    vi.mocked(fs.open).mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === `${lock}.reclaim` && lateCalls++ === 1) await pause(200)
      return real.open(...args)
    }) as typeof fs.open)
  }
}

function staleLock(client: DiskRecordClient, name: string, suffix = '.lock'): string {
  const lock = `${client.path(name)}${suffix}`
  writeFileSync(lock, '424242')
  const old = (Date.now() - 100_000) / 1000
  utimesSync(lock, old, old)
  return lock
}

describe('DiskRecordClient lock reclaim and release', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mirage-record-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it.each(LATE_STEPS)(
    'never lets two reclaimers of one stale lock both hold it (%s)',
    async (_, lateStep) => {
      const client = new DiskRecordClient(root, '')
      raceTwoReclaimers(staleLock(client, 'k'), lateStep)
      let inside = 0
      let most = 0
      const hold = async (): Promise<void> => {
        const fh = await client.lock('k')
        inside += 1
        most = Math.max(most, inside)
        await pause(300)
        inside -= 1
        await client.unlock('k', fh)
      }
      await Promise.all([hold(), hold()])
      expect(most).toBe(1)
      expect(readdirSync(root)).toEqual([])
    },
  )

  it.each(LATE_STEPS)(
    'gives two claims over one stale lock one winner (%s)',
    async (_, lateStep) => {
      const client = new DiskRecordClient(root, '')
      await client.put('ws', { generation: 0, owner: null })
      raceTwoReclaimers(staleLock(client, 'ws'), lateStep)
      const read = client.get.bind(client)
      vi.spyOn(client, 'get').mockImplementation(async (name) => {
        const found = await read(name)
        await pause(300)
        return found
      })
      const won = await Promise.all([
        client.casPut('ws', { generation: 1, owner: 'alice' }, 0),
        client.casPut('ws', { generation: 1, owner: 'bob' }, 0),
      ])
      expect(won.sort()).toEqual([false, true])
      expect(readdirSync(root)).toEqual(['ws.json'])
    },
  )

  it('lets the next claim win over a stale guard', async () => {
    const client = new DiskRecordClient(root, '')
    staleLock(client, 'k')
    staleLock(client, 'k', '.lock.reclaim')
    expect(await client.casPut('k', { generation: 1 }, 0)).toBe(true)
    expect(readdirSync(root)).toEqual(['k.json'])
  })

  it('lets the claim win when its guard is reclaimed mid-reclaim', async () => {
    const client = new DiskRecordClient(root, '')
    const lock = staleLock(client, 'k')
    let stats = 0
    vi.mocked(fs.stat).mockImplementation((async (p: string, opts?: { bigint?: boolean }) => {
      if (p === lock && stats++ === 1) await real.unlink(`${lock}.reclaim`)
      return real.stat(p, opts)
    }) as typeof fs.stat)
    expect(await client.casPut('k', { generation: 1 }, 0)).toBe(true)
    expect(readdirSync(root)).toEqual(['k.json'])
  })

  it('leaves the lock when a reclaimer loses the guard it freed', async () => {
    const client = new DiskRecordClient(root, '')
    const lock = staleLock(client, 'k')
    const guard = staleLock(client, 'k', '.lock.reclaim')
    let opens = 0
    vi.mocked(fs.open).mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === guard && opens++ === 1) {
        throw Object.assign(new Error(`EEXIST: ${guard}`), { code: 'EEXIST' })
      }
      return real.open(...args)
    }) as typeof fs.open)
    const reclaim = client as unknown as { reclaimStaleLock(path: string): Promise<boolean> }
    expect(await reclaim.reclaimStaleLock(lock)).toBe(false)
    expect(readdirSync(root)).toEqual(['k.json.lock'])
  })

  it('leaves a lock another writer took on release', async () => {
    const client = new DiskRecordClient(root, '')
    const mine = await client.lock('k')
    const lock = `${client.path('k')}.lock`
    rmSync(lock)
    const theirs = await client.lock('k')
    await client.unlock('k', mine)
    expect(readdirSync(root)).toEqual(['k.json.lock'])
    await client.unlock('k', theirs)
    expect(readdirSync(root)).toEqual([])
  })

  it('closes the lock before unlinking it on release', async () => {
    const client = new DiskRecordClient(root, '')
    const fh = await client.lock('k')
    const lock = `${client.path('k')}.lock`
    const steps: string[] = []
    const close = fh.close.bind(fh)
    fh.close = async () => {
      steps.push('close')
      await close()
    }
    vi.mocked(fs.unlink).mockImplementation(async (p) => {
      if (p === lock) steps.push('unlink')
      await real.unlink(p)
    })
    await client.unlock('k', fh)
    expect(steps).toEqual(['close', 'unlink'])
  })

  it.each([
    ['before', false],
    ['after', true],
  ])('releases a lock that vanished %s its ownership check', async (_, afterCheck) => {
    const client = new DiskRecordClient(root, '')
    const fh = await client.lock('k')
    const lock = `${client.path('k')}.lock`
    if (afterCheck) {
      vi.mocked(fs.stat).mockImplementation((async (p: string, opts?: { bigint?: boolean }) => {
        const found = await real.stat(p, opts)
        if (p === lock) await real.unlink(p)
        return found
      }) as typeof fs.stat)
    } else {
      rmSync(lock)
    }
    await client.unlock('k', fh)
    expect(readdirSync(root)).toEqual([])
  })

  it('puts a record on disk before renaming it in', async () => {
    const steps: ([string, bigint, bigint] | ['close'])[] = []
    vi.mocked(fs.open).mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const fh = await real.open(...args)
      const sync = fh.sync.bind(fh)
      const close = fh.close.bind(fh)
      fh.sync = async () => {
        const held = await fh.stat({ bigint: true })
        steps.push(['sync', held.size, held.ino])
        await sync()
      }
      fh.close = async () => {
        steps.push(['close'])
        await close()
      }
      return fh
    }) as typeof fs.open)
    vi.mocked(fs.rename).mockImplementation(async (src, dst) => {
      const moved = await real.stat(src, { bigint: true })
      steps.push(['rename', moved.size, moved.ino])
      await real.rename(src, dst)
    })
    const client = new DiskRecordClient(root, '')
    await client.put('k', { generation: 0 })
    const body = BigInt(JSON.stringify({ generation: 0 }).length)
    const record = (await real.stat(client.path('k'), { bigint: true })).ino
    expect(steps).toEqual([['sync', body, record], ['close'], ['rename', body, record]])
  })
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
