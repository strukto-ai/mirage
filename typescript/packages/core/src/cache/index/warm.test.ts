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
import { enoent, enotdir } from '../../errors/fs.ts'
import { IndexEntry, LookupStatus } from './config.ts'
import { RAMIndexCacheStore } from './ram.ts'
import { RedisIndexCacheStore } from './redis.ts'
import { IndexCacheStore } from './store.ts'
import { entryOrWarm } from './warm.ts'

const KEY = '/owned/notes.json'

function entryFor(id: string): IndexEntry {
  return new IndexEntry({ id, name: 'notes', resourceType: 'gdocs', vfsName: 'notes.json' })
}

describe('cache/index/warm: entryOrWarm', () => {
  it('lets a custom store inherit the conservative partial write', async () => {
    const index = new RAMIndexCacheStore()
    await index.setDir('/owned', [['old.json', entryFor('old')]])
    await IndexCacheStore.prototype.setPartialDir.call(index, '/owned', [
      ['notes.json', entryFor('new')],
    ])
    expect((await index.listDir('/owned')).entries).toBeUndefined()
    expect((await index.get('/owned/old.json')).entry).toBeUndefined()
    expect((await index.get(KEY)).entry?.id).toBe('new')
  })

  it('returns a warm hit without listing the parent', async () => {
    const index = new RAMIndexCacheStore()
    await index.setDir('/owned', [['notes.json', entryFor('doc-1')]])
    let calls = 0
    const got = await entryOrWarm(index, KEY, () => {
      calls += 1
      return Promise.resolve()
    })
    expect(got?.id).toBe('doc-1')
    expect(calls).toBe(0)
  })

  it('lists the parent once on a miss, then serves what the listing put there', async () => {
    const index = new RAMIndexCacheStore()
    let calls = 0
    const got = await entryOrWarm(index, KEY, async () => {
      calls += 1
      await index.put(KEY, entryFor('doc-2'))
    })
    expect(got?.id).toBe('doc-2')
    expect(calls).toBe(1)
  })

  it('returns null when the listing did not produce the entry', async () => {
    const index = new RAMIndexCacheStore()
    const got = await entryOrWarm(index, KEY, () => Promise.resolve())
    expect(got).toBeNull()
  })

  it('returns null without listing when there is no parent to list', async () => {
    const index = new RAMIndexCacheStore()
    const got = await entryOrWarm(index, KEY, null)
    expect(got).toBeNull()
  })

  // The whole point of the helper: exactly one error means "not there".
  it('swallows an absent parent, so the caller can name the operand', async () => {
    const index = new RAMIndexCacheStore()
    const got = await entryOrWarm(index, KEY, () => Promise.reject(enoent('/owned')))
    expect(got).toBeNull()
  })

  it('propagates an auth or transport failure instead of reading as missing', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      entryOrWarm(index, KEY, () => Promise.reject(new Error('401 Unauthorized'))),
    ).rejects.toThrow(/401 Unauthorized/)
  })

  it('propagates a non-ENOENT fs error too, not just untyped ones', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      entryOrWarm(index, KEY, () => Promise.reject(enotdir('/owned'))),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `retained entries with ${backend}`,
    () => {
      it.each(['expired', 'directory', 'prefix', 'all', 'clear'])(
        'partial membership is positive only and respects %s invalidation',
        async (stale) => {
          const url = process.env.REDIS_URL
          const index =
            backend === 'ram'
              ? new RAMIndexCacheStore()
              : new RedisIndexCacheStore({
                  ...(url === undefined ? {} : { url }),
                  keyPrefix: `partial:${crypto.randomUUID()}:`,
                })
          let calls = 0
          const warm = async (): Promise<void> => {
            calls += 1
            await index.setPartialDir('/owned', [['notes.json', entryFor('new')]])
          }
          try {
            await index.setDir('/owned', [['other.json', entryFor('old')]])
            await index.setPartialDir('/owned', [['notes.json', entryFor('current')]])
            const listing = await index.listDir('/owned')
            expect(listing.entries).toBeUndefined()
            expect(listing.partialEntries).toEqual([KEY])
            expect((await entryOrWarm(index, KEY, warm))?.id).toBe('current')
            expect(calls).toBe(0)
            expect(await entryOrWarm(index, '/owned/other.json', warm)).toBeNull()
            expect(calls).toBe(1)
            if (stale === 'expired')
              await index.setPartialDir(
                '/owned',
                [['notes.json', entryFor('old')]],
                new Date(Date.now() - 1000),
              )
            else if (stale === 'directory') await index.invalidateDir('/owned')
            else if (stale === 'prefix') await index.invalidatePrefix('/owned')
            else if (stale === 'all') await index.invalidate()
            else await index.clear()
            expect((await entryOrWarm(index, KEY, warm))?.id).toBe('new')
            expect(calls).toBe(2)
            expect((await entryOrWarm(index, KEY, warm))?.id).toBe('new')
            expect(calls).toBe(2)
            await index.setDir('/owned', [])
            expect((await index.listDir('/owned')).partialEntries).toBeUndefined()
            expect(await entryOrWarm(index, KEY, warm)).toBeNull()
            expect(calls).toBe(2)
          } finally {
            await index.clear()
            await index.close()
          }
        },
      )

      describe.each([false, true])('orphan rows, globally invalidated: %s', (invalidated) => {
        it.each(['updated', 'renamed', 'deleted', 'partial', 'absent', 'error'])(
          'revalidates every direct lookup until the parent is complete: %s',
          async (outcome) => {
            const url = process.env.REDIS_URL
            const index =
              backend === 'ram'
                ? new RAMIndexCacheStore()
                : new RedisIndexCacheStore({
                    ...(url === undefined ? {} : { url }),
                    keyPrefix: `warm:${crypto.randomUUID()}:`,
                  })
            let calls = 0
            const warm = async (): Promise<void> => {
              calls += 1
              if (outcome === 'absent') throw enoent('/owned')
              if (outcome === 'error') throw new Error('unavailable')
              if (outcome === 'partial') await index.put('/owned/other.json', entryFor('other'))
              else
                await index.setDir(
                  '/owned',
                  outcome === 'updated'
                    ? [['notes.json', entryFor('new')]]
                    : outcome === 'renamed'
                      ? [['renamed.json', entryFor('old')]]
                      : [],
                )
            }
            try {
              // Partial service listings and point writes can create rows
              // without ever publishing a complete parent directory.
              await index.put(KEY, entryFor('old'))
              if (invalidated) await index.invalidate()
              expect((await index.get(KEY)).entry?.id).toBe('old')
              expect((await index.listDir('/owned')).status).toBe(LookupStatus.NOT_FOUND)
              for (let attempt = 0; attempt < 2; attempt += 1) {
                if (outcome === 'error')
                  await expect(entryOrWarm(index, KEY, warm)).rejects.toThrow('unavailable')
                else
                  expect((await entryOrWarm(index, KEY, warm))?.id ?? null).toBe(
                    outcome === 'updated' ? 'new' : null,
                  )
              }
              const incomplete = ['partial', 'absent', 'error'].includes(outcome)
              expect(calls).toBe(incomplete ? 2 : 1)
              if (outcome !== 'updated') expect((await index.get(KEY)).entry ?? null).toBeNull()
              if (outcome === 'renamed')
                expect((await index.get('/owned/renamed.json')).entry?.id).toBe('old')
            } finally {
              await index.clear()
              await index.close()
            }
          },
        )
      })

      it('accepts a newly warmed put-only row, then revalidates it on the next lookup', async () => {
        const url = process.env.REDIS_URL
        const index =
          backend === 'ram'
            ? new RAMIndexCacheStore()
            : new RedisIndexCacheStore({
                ...(url === undefined ? {} : { url }),
                keyPrefix: `warm:${crypto.randomUUID()}:`,
              })
        let calls = 0
        const warm = async (): Promise<void> => {
          calls += 1
          if (calls === 1) await index.put(KEY, entryFor('new'))
        }
        try {
          await index.put(KEY, entryFor('old'))
          await index.invalidate()
          expect((await entryOrWarm(index, KEY, warm))?.id).toBe('new')
          expect(await entryOrWarm(index, KEY, warm)).toBeNull()
          expect(await entryOrWarm(index, KEY, warm)).toBeNull()
          expect(calls).toBe(3)
        } finally {
          await index.clear()
          await index.close()
        }
      })

      it.each(['updated', 'deleted', 'partial', 'absent', 'error'])(
        'refreshes an invalidated parent: %s',
        async (outcome) => {
          const url = process.env.REDIS_URL
          const index =
            backend === 'ram'
              ? new RAMIndexCacheStore()
              : new RedisIndexCacheStore({
                  ...(url === undefined ? {} : { url }),
                  keyPrefix: `warm:${crypto.randomUUID()}:`,
                })
          let calls = 0
          const warm = async (): Promise<void> => {
            calls += 1
            if (outcome === 'absent') throw enoent('/owned')
            if (outcome === 'error') throw new Error('unavailable')
            if (outcome === 'partial') await index.put('/owned/other.json', entryFor('other'))
            else
              await index.setDir(
                '/owned',
                outcome === 'updated' ? [['notes.json', entryFor('new')]] : [],
              )
          }
          try {
            await index.setDir('/owned', [['notes.json', entryFor('old')]])
            await index.invalidate()
            expect((await index.get(KEY)).entry?.id).toBe('old')
            if (outcome === 'error')
              await expect(entryOrWarm(index, KEY, warm)).rejects.toThrow('unavailable')
            else
              expect((await entryOrWarm(index, KEY, warm))?.id ?? null).toBe(
                outcome === 'updated' ? 'new' : null,
              )
            expect(calls).toBe(1)
            await index.put(KEY, entryFor('obsolete'))
            await index.setDir('/owned', [])
            expect(await entryOrWarm(index, KEY, warm)).toBeNull()
            expect(calls).toBe(1)
          } finally {
            await index.clear()
            await index.close()
          }
        },
      )
    },
  )
}

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && process.env.REDIS_URL === undefined)(
    `parallel parent refreshes with ${backend}`,
    () => {
      it.each(['expired', 'missing'])('rechecks a %s parent under the lock', async (state) => {
        const url = process.env.REDIS_URL
        const index =
          backend === 'ram'
            ? new RAMIndexCacheStore()
            : new RedisIndexCacheStore({
                ...(url === undefined ? {} : { url }),
                keyPrefix: `parallel-warm:${crypto.randomUUID()}:`,
              })
        let calls = 0
        const names = ['notes.json', 'other.json']
        try {
          if (state === 'expired') {
            await index.setDir(
              '/owned',
              names.map((name) => [name, entryFor('old')]),
            )
            await index.invalidate()
          } else {
            for (const name of names) await index.put(`/owned/${name}`, entryFor('old'))
          }
          const warm = async () => {
            calls += 1
            await Promise.resolve()
            await index.setDir(
              '/owned',
              names.map((name) => [name, entryFor(name)]),
            )
            await Promise.resolve()
          }
          const keys = Array.from({ length: 8 }, (_, i) => names[i % names.length] ?? '')
          const found = await Promise.all(
            keys.map((key) => entryOrWarm(index, `/owned/${key}`, warm)),
          )
          expect(found.map((row) => row?.id)).toEqual(keys)
          expect(calls).toBe(1)
        } finally {
          await index.clear()
          await index.close()
        }
      })
    },
  )
}

it('keeps a partial refresh available through its own retry', async () => {
  const index = new RAMIndexCacheStore()
  let published!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    published = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const warm = async () => {
    calls += 1
    await index.put(KEY, entryFor(String(calls)))
    if (calls === 1) {
      published()
      await gate
    }
  }
  const first = entryOrWarm(index, KEY, warm)
  await entered
  const second = entryOrWarm(index, KEY, warm)
  // The unguarded second lookup can discard the first call's published row.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
  release()
  const found = await Promise.all([first, second])
  expect(found.map((row) => row?.id)).toEqual(['1', '2'])
})

it('releases a parent after the refresh rejects', async () => {
  const index = new RAMIndexCacheStore()
  await expect(
    entryOrWarm(index, KEY, () => Promise.reject(new Error('unavailable'))),
  ).rejects.toThrow('unavailable')
  const found = await entryOrWarm(index, KEY, () =>
    index.setDir('/owned', [['notes.json', entryFor('new')]]),
  )
  expect(found?.id).toBe('new')
})
