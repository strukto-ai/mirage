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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Evicted,
  type SetDirOptions,
  IndexEntry,
  IndexType,
  LookupStatus,
  type IndexConfig,
  type RedisIndexConfig,
} from './config.ts'
import { withCacheMutation } from '../file/io.ts'
import { RAMFileCacheStore } from '../file/ram.ts'
import { RAMIndexCacheStore } from './ram.ts'
import { RedisIndexCacheStore } from './redis.ts'
import type { IndexCacheStore } from './store.ts'
import { IndexView } from './view.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { runWithSession } from '../../context/session_context.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { SessionState } from '../../workspace/session/session.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const cases = ['backend', 'store'].flatMap((phase) =>
  ['put', 'setDir', 'setPartialDir'].flatMap((method) =>
    [false, true].map((shadow) => ({ phase, method, shadow })),
  ),
)

for (const type of [IndexType.RAM, IndexType.REDIS]) {
  describe(`index lifecycle (${type})`, () => {
    it
      .skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined)
      .each(['readlink', 'rename'])(
      'fences metadata writes from internal %s probes',
      async (op) => {
        const url = process.env.REDIS_URL
        const config: IndexConfig | RedisIndexConfig =
          type === IndexType.REDIS
            ? {
                type,
                ...(url === undefined ? {} : { url }),
                keyPrefix: `lifecycle:${crypto.randomUUID()}:`,
              }
            : { type }
        const vfs = new RAMVFS()
        const ws = new Workspace({ '/data': vfs }, { index: config, mode: MountMode.WRITE })
        ws.addMount('/alias', vfs)
        const index = ws.mount('/data').indexStore
        let enter = (): void => undefined
        let resume = (): void => undefined
        const entered = new Promise<void>((resolve) => {
          enter = resolve
        })
        const release = new Promise<void>((resolve) => {
          resume = resolve
        })
        ws.opsRegistry.register({
          name: 'stat',
          vfs: 'ram',
          filetype: null,
          write: false,
          fn: async (_accessor, _path, _args, { index }) => {
            if (index === undefined) throw new Error('missing index')
            enter()
            await release
            await index.put(
              '/data/stale',
              new IndexEntry({ id: 'old', name: 'stale', resourceType: 'file' }),
            )
            return new FileStat({
              name: 'source',
              type: op === 'rename' ? FileType.DIRECTORY : FileType.FILE,
            })
          },
        })
        const session = new SessionState({
          sessionId: 'agent',
          visibility: { paths: { paths: ['/data/source/private'] } },
        })
        const reading = runWithSession(session, () =>
          ws.dispatch(
            op,
            '/data/source',
            op === 'rename' ? [PathSpec.fromStrPath('/data/destination')] : [],
          ),
        ).then(
          () => undefined,
          (err: unknown) => (err instanceof Error && 'code' in err ? err.code : undefined),
        )
        try {
          await entered
          await ws.unmount('/data')
          const fresh = ws.addMount('/data', new RAMVFS()).indexStore
          await ws.vfs.readdir('/data')
          await fresh.put(
            '/data/fresh',
            new IndexEntry({ id: 'new', name: 'fresh', resourceType: 'file' }),
          )
          resume()
          expect(await reading).toBe(op === 'rename' ? 'EACCES' : 'EINVAL')
          for (const candidate of [index, fresh]) {
            expect((await candidate.get('/data/stale')).status).toBe(LookupStatus.NOT_FOUND)
          }
          expect((await fresh.get('/data/fresh')).entry?.id).toBe('new')
        } finally {
          resume()
          await reading
          await index.clear()
          await ws.close()
        }
      },
    )

    it.skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined).each(cases)(
      'fences $phase $method writes across mount changes (shadow=$shadow)',
      async ({ phase, method, shadow }) => {
        const url = process.env.REDIS_URL
        const config: IndexConfig | RedisIndexConfig =
          type === IndexType.REDIS
            ? {
                type,
                ...(url === undefined ? {} : { url }),
                keyPrefix: `lifecycle:${crypto.randomUUID()}:`,
              }
            : { type }
        const vfs = new RAMVFS()
        const prefix = shadow ? '/' : '/data'
        const ws = new Workspace({ [prefix]: vfs }, { index: config })
        ws.addMount('/alias', vfs)
        const index = ws.mount(prefix).indexStore
        const entry = new IndexEntry({ id: 'old', name: 'stale', resourceType: 'file' })
        let enter = (): void => undefined
        let resume = (): void => undefined
        const entered = new Promise<void>((resolve) => {
          enter = resolve
        })
        const release = new Promise<void>((resolve) => {
          resume = resolve
        })
        const pause = async (): Promise<void> => {
          enter()
          await release
        }
        if (phase === 'store') {
          if (method === 'put') {
            const original = index.put.bind(index)
            vi.spyOn(index, 'put').mockImplementation(async (...args) => {
              await pause()
              await original(...args)
            })
          } else if (method === 'setPartialDir') {
            const original = index.setPartialDir.bind(index)
            vi.spyOn(index, 'setPartialDir').mockImplementation(async (...args) => {
              await pause()
              await original(...args)
            })
          } else {
            const original = index.setDir.bind(index)
            vi.spyOn(index, 'setDir').mockImplementation(async (...args) => {
              await pause()
              return original(...args)
            })
          }
        }
        ws.opsRegistry.register({
          name: 'readdir',
          vfs: 'ram',
          filetype: null,
          write: false,
          fn: async (_accessor, _path, _args, { index }) => {
            if (index === undefined) throw new Error('missing index')
            if (phase === 'backend') await pause()
            if (method === 'put') await index.put('/data/stale', entry)
            else if (method === 'setPartialDir')
              await index.setPartialDir('/data', [['stale', entry]])
            else await index.setDir('/data', [['stale', entry]])
            return ['/data/stale']
          },
        })
        const reading = ws.vfs.readdir('/data')
        let changing: Promise<unknown> | undefined
        const replacement = new RAMVFS()
        replacement.store.files.set('/own', new TextEncoder().encode('own\n'))
        try {
          await entered
          let changed = false
          if (shadow) {
            ws.addMount('/data', replacement)
            changing = ws.vfs.readdir('/data').then(() => {
              changed = true
            })
          } else {
            changing = ws.unmount('/data').then(() => {
              changed = true
            })
          }
          await Promise.resolve()
          if (phase === 'store') {
            expect(changed).toBe(false)
            resume()
          }
          await changing
          if (!shadow) {
            ws.addMount('/data', replacement)
            await ws.vfs.readdir('/data')
          }
          const fresh = ws.mount('/data').indexStore
          await fresh.put(
            '/data/fresh',
            new IndexEntry({ id: 'new', name: 'fresh', resourceType: 'file' }),
          )
          resume()
          await reading
          for (const candidate of [index, fresh]) {
            expect((await candidate.get('/data/stale')).status).toBe(LookupStatus.NOT_FOUND)
            expect((await candidate.listDir('/data')).entries ?? []).not.toContain('/data/stale')
            if (method !== 'put') {
              const listing = await candidate.listDir('/data')
              // One redis keyspace backs every mount, so each handle reads the
              // replacement's own listing; ram gives each mount its own store.
              const shares = candidate === fresh || type === IndexType.REDIS
              const own = shares ? ['/data/own'] : null
              expect([listing.entries ?? null, listing.partialEntries ?? null]).toEqual([own, null])
            }
          }
          expect((await fresh.get('/data/fresh')).entry?.id).toBe('new')
        } finally {
          resume()
          await Promise.allSettled([reading, changing])
          await index.clear()
          await ws.close()
        }
      },
    )
  })
}

it('filters seeded snapshots and entries through mount ownership', async () => {
  const store = new RAMIndexCacheStore()
  const cache = new RAMFileCacheStore()
  let active = true
  const view = new IndexView(
    store,
    cache,
    '/data',
    (path) => active && (path === '/data' || path === '/data/a'),
  )
  const entry = new IndexEntry({ id: 'a', name: 'a', resourceType: 'file' })
  try {
    view.seed(
      new Map([
        ['/data/a', entry],
        ['/data/hidden', entry],
      ]),
      new Map([['/data', ['/data/a', '/data/hidden']]]),
      new Date(Date.now() + 3600000),
    )
    expect((await view.listDir('/data')).entries).toEqual(['/data/a'])
    expect([...(await view.entries())].map(([path]) => path)).toEqual(['/data/a'])
    active = false
    expect(await view.entries()).toEqual(new Map())
    view.seed(new Map([['/data/late', entry]]), new Map(), new Date())
    expect((await store.get('/data/late')).status).toBe(LookupStatus.NOT_FOUND)
  } finally {
    await cache.close()
  }
})

const ROW = new IndexEntry({ id: 'a', name: 'a', resourceType: 'file' })

function settleWithin<T>(work: Promise<T>, ms: number): Promise<'done' | 'pending'> {
  return Promise.race([
    work.then(() => 'done' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => {
        resolve('pending')
      }, ms)
    }),
  ])
}

/** Take the workspace mutation lock the way a shell glob does, until released. */
function holdMutation(cache: RAMFileCacheStore): {
  entered: Promise<void>
  release: () => void
  done: Promise<void>
} {
  let enter = (): void => undefined
  let release = (): void => undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const done = withCacheMutation(cache, async () => {
    enter()
    await gate
  })
  return { entered, release, done }
}

const FENCED: [string, (view: IndexView) => Promise<unknown>][] = [
  ['get', (view) => view.get('/data/a')],
  ['listDir', (view) => view.listDir('/data')],
  ['put', (view) => view.put('/data/a', ROW)],
  ['setDir', (view) => view.setDir('/data', [['a', ROW]])],
  ['setPartialDir', (view) => view.setPartialDir('/data', [['a', ROW]])],
  ['entries', (view) => view.entries()],
  ['invalidateDir', (view) => view.invalidateDir('/data')],
  ['invalidatePrefix', (view) => view.invalidatePrefix('/data')],
  ['invalidate', (view) => view.invalidate()],
  ['holdsSubtree', (view) => view.holdsSubtree('/data')],
]

describe('a lock-held view', () => {
  it.each(FENCED)('%s completes while its caller holds the mutation lock', async (_, call) => {
    const cache = new RAMFileCacheStore()
    const view = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => true, {
      locked: true,
    })
    const held = holdMutation(cache)
    try {
      await held.entered
      expect(await settleWithin(call(view), 1000)).toBe('done')
    } finally {
      held.release()
      await held.done
      await cache.close()
    }
  })

  it.each(FENCED)('%s on an unlocked view waits for the mutation lock', async (_, call) => {
    const cache = new RAMFileCacheStore()
    const view = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => true)
    const held = holdMutation(cache)
    try {
      await held.entered
      const pending = call(view)
      expect(await settleWithin(pending, 20)).toBe('pending')
      held.release()
      expect(await settleWithin(pending, 1000)).toBe('done')
    } finally {
      held.release()
      await held.done
      await cache.close()
    }
  })

  it.each([false, true])('keeps the ownership fence (owns=%s)', async (owned) => {
    const cache = new RAMFileCacheStore()
    const store = new RAMIndexCacheStore()
    const view = new IndexView(store, cache, '/data', () => owned, { locked: true })
    const held = holdMutation(cache)
    try {
      await held.entered
      expect(await settleWithin(view.put('/data/p', ROW), 1000)).toBe('done')
      expect(await settleWithin(view.setDir('/data/full', [['a', ROW]]), 1000)).toBe('done')
      expect(await settleWithin(view.setPartialDir('/data/part', [['a', ROW]]), 1000)).toBe('done')
    } finally {
      held.release()
      await held.done
    }
    try {
      if (owned) {
        expect((await store.get('/data/p')).entry?.id).toBe('a')
        expect((await store.listDir('/data/full')).entries).toEqual(['/data/full/a'])
        expect((await store.listDir('/data/part')).partialEntries).toEqual(['/data/part/a'])
      } else {
        expect(await store.entries()).toEqual(new Map())
        expect((await store.listDir('/data/full')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.listDir('/data/part')).status).toBe(LookupStatus.NOT_FOUND)
      }
    } finally {
      await cache.close()
    }
  })
})

const T0 = new Date('2026-01-01T00:00:00Z')
const YEAR = 365 * 24 * 60 * 60 * 1000

type Explicit = 'none' | 'year' | 'epoch'

function expiryOf(explicit: Explicit): Date | undefined {
  if (explicit === 'year') return new Date(Date.now() + YEAR)
  if (explicit === 'epoch') return new Date(0)
  return undefined
}

class ExpirySpy extends RAMIndexCacheStore {
  readonly asked: (Date | null | undefined)[] = []
  override setDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options?: SetDirOptions,
  ): Promise<Evicted[]> {
    this.asked.push(expiredAt)
    return super.setDir(path, entries, expiredAt, options)
  }
  override setPartialDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    this.asked.push(expiredAt)
    return super.setPartialDir(path, entries, expiredAt)
  }
}

describe('the view caps listing expiry at the mount ttl', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // [row, store ttl, read ttl, explicit expiry, seconds after the write, live]
  const ROWS: [number, number, number | undefined, Explicit, number, boolean][] = [
    [1, 86400, 2, 'none', 3, false],
    [2, 86400, 2, 'none', 1, true],
    [3, 60, 600, 'none', 61, false],
    [4, 60, 600, 'none', 59, true],
    [5, 0, 600, 'none', 0, false],
    [6, 86400, 2, 'year', 3, false],
    [7, 60, 600, 'year', 61, true],
    [8, 86400, 2, 'epoch', 0, false],
    [9, 86400, undefined, 'none', 3, true],
    [10, 86400, undefined, 'year', 3, true],
  ]
  for (const method of ['setDir', 'setPartialDir'] as const) {
    it.each(ROWS)(
      `${method} row %i: store ttl %d, read ttl %s, expiry %s, +%ds -> live=%s`,
      async (_row, storeTtl, readTtl, explicit, after, live) => {
        const cache = new RAMFileCacheStore()
        const store = new RAMIndexCacheStore({ ttl: storeTtl })
        const view = new IndexView(
          store,
          cache,
          '/data',
          () => true,
          readTtl === undefined ? {} : { readTtl },
        )
        try {
          await view[method]('/data', [['a', ROW]], expiryOf(explicit))
          vi.setSystemTime(Date.now() + after * 1000)
          const listing = await store.listDir('/data')
          if (live) expect(listing.status ?? 'live').toBe('live')
          else expect(listing.status).toBe(LookupStatus.EXPIRED)
        } finally {
          await cache.close()
        }
      },
    )

    it(`${method} row 11: takes now at the write, not at construction`, async () => {
      const cache = new RAMFileCacheStore()
      const store = new RAMIndexCacheStore({ ttl: 86400 })
      const view = new IndexView(store, cache, '/data', () => true, { readTtl: 2 })
      try {
        vi.setSystemTime(Date.now() + 5000)
        await view[method]('/data', [['a', ROW]])
        const written = Date.now()
        vi.setSystemTime(written + 1000)
        expect((await store.listDir('/data')).status ?? 'live').toBe('live')
        vi.setSystemTime(written + 3000)
        expect((await store.listDir('/data')).status).toBe(LookupStatus.EXPIRED)
      } finally {
        await cache.close()
      }
    })

    it(`${method} passes the writer's expiry through when the cap does not bite`, async () => {
      const cache = new RAMFileCacheStore()
      const store = new ExpirySpy({ ttl: 60 })
      const view = new IndexView(store, cache, '/data', () => true, { readTtl: 600 })
      try {
        await view[method]('/data', [['a', ROW]])
        expect(store.asked).toHaveLength(1)
        expect(store.asked[0] ?? null).toBeNull()
      } finally {
        await cache.close()
      }
    })

    it(`${method} hands the store a deadline when the cap bites`, async () => {
      const cache = new RAMFileCacheStore()
      const store = new ExpirySpy({ ttl: 86400 })
      const view = new IndexView(store, cache, '/data', () => true, { readTtl: 2 })
      try {
        await view[method]('/data', [['a', ROW]])
        expect(store.asked).toHaveLength(1)
        expect(store.asked[0]).toBeInstanceOf(Date)
      } finally {
        await cache.close()
      }
    })
  }

  it('clamps a seed for every folder', async () => {
    const cache = new RAMFileCacheStore()
    const store = new RAMIndexCacheStore({ ttl: 86400 })
    const view = new IndexView(store, cache, '/data', () => true, { readTtl: 2 })
    try {
      view.seed(
        new Map([
          ['/data/a', ROW],
          ['/data/b/a', ROW],
        ]),
        new Map([
          ['/data', ['/data/a', '/data/b']],
          ['/data/b', ['/data/b/a']],
          ['/data/c', []],
        ]),
        new Date(Date.now() + YEAR),
      )
      vi.setSystemTime(Date.now() + 3000)
      for (const dir of ['/data', '/data/b', '/data/c'])
        expect((await store.listDir(dir)).status, dir).toBe(LookupStatus.EXPIRED)
    } finally {
      await cache.close()
    }
  })

  it('keeps an epoch-zero seed expired', async () => {
    const cache = new RAMFileCacheStore()
    const store = new RAMIndexCacheStore({ ttl: 86400 })
    const view = new IndexView(store, cache, '/data', () => true, { readTtl: 2 })
    try {
      view.seed(new Map([['/data/a', ROW]]), new Map([['/data', ['/data/a']]]), new Date(0))
      expect((await store.listDir('/data')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      await cache.close()
    }
  })

  it('takes the deadline after waiting for the mutation lock', async () => {
    const cache = new RAMFileCacheStore()
    const store = new RAMIndexCacheStore({ ttl: 86400 })
    const view = new IndexView(store, cache, '/data', () => true, { readTtl: 2 })
    const held = holdMutation(cache)
    try {
      await held.entered
      const writing = view.setDir('/data', [['a', ROW]])
      vi.setSystemTime(Date.now() + 1500)
      held.release()
      await writing
      const released = Date.now()
      vi.setSystemTime(released + 1000)
      expect((await store.listDir('/data')).status ?? 'live').toBe('live')
      vi.setSystemTime(released + 2100)
      expect((await store.listDir('/data')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      held.release()
      await held.done
      await cache.close()
    }
  })
})

describe('IndexView cleanup after a re-list', () => {
  const row = (name: string, resourceType = 'file'): IndexEntry =>
    new IndexEntry({ id: name, name, resourceType })

  function ledger(): [Evicted[], (gone: readonly Evicted[]) => Promise<void>] {
    const seen: Evicted[] = []
    return [
      seen,
      (gone) => {
        seen.push(...gone)
        return Promise.resolve()
      },
    ]
  }

  it('hands each dropped child to cleanup', async () => {
    const [seen, onGone] = ledger()
    const view = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/data',
      () => true,
      { onGone },
    )
    await view.setDir('/data', [
      ['a', row('a')],
      ['sub', row('sub', 'folder')],
    ])
    await view.setDir('/data', [])
    expect(seen).toEqual([
      { path: '/data/a', folder: false },
      { path: '/data/sub', folder: true },
    ])
  })

  it('hands nothing to cleanup for a window', async () => {
    const [seen, onGone] = ledger()
    const view = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/data',
      () => true,
      { onGone },
    )
    await view.setDir('/data', [['a', row('a')]])
    await view.setDir('/data', [], null, { window: true })
    expect(seen).toEqual([])
  })

  // A nested mount took /data/n after the parent listed it.
  it('skips a key the mount no longer owns', async () => {
    const [seen, onGone] = ledger()
    const owned = new Set(['/data', '/data/a', '/data/n'])
    const view = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/data',
      (k) => owned.has(k),
      {
        onGone,
      },
    )
    await view.setDir('/data', [
      ['a', row('a')],
      ['n', row('n')],
    ])
    owned.delete('/data/n')
    // What setDir hands back is filtered too, not only what cleanup sees.
    expect(await view.setDir('/data', [])).toEqual([{ path: '/data/a', folder: false }])
    expect(seen).toEqual([{ path: '/data/a', folder: false }])
  })

  // The mount table can change between the fenced write and the cleanup.
  it('rechecks ownership after the write', async () => {
    const [seen, onGone] = ledger()
    const owned = new Set(['/data', '/data/a'])
    const store = new RAMIndexCacheStore()
    const view = new IndexView(store, new RAMFileCacheStore(), '/data', (k) => owned.has(k), {
      onGone,
    })
    await view.setDir('/data', [['a', row('a')]])
    const original = store.setDir.bind(store)
    vi.spyOn(store, 'setDir').mockImplementation(async (...args) => {
      const gone = await original(...args)
      owned.delete('/data/a')
      return gone
    })
    await view.setDir('/data', [])
    expect(seen).toEqual([])
  })

  // Cleanup evicts file-cache entries; inside the fence it would wait on the
  // lock its own write holds.
  it('runs cleanup after the fence', async () => {
    const cache = new RAMFileCacheStore()
    const done: string[] = []
    const view = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => true, {
      onGone: (gone) =>
        withCacheMutation(cache, () => {
          done.push(...gone.map((child) => child.path))
          return Promise.resolve()
        }),
    })
    await view.setDir('/data', [['a', row('a')]])
    await view.setDir('/data', [])
    expect(done).toEqual(['/data/a'])
  })

  it('hands owned reported keys to cleanup', async () => {
    const [seen, onGone] = ledger()
    const view = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/data',
      (k) => k !== '/data/n',
      {
        onGone,
      },
    )
    await view.reportGone([
      { path: '/data/a', folder: false },
      { path: '/data/n', folder: true },
    ])
    expect(seen).toEqual([{ path: '/data/a', folder: false }])
  })

  it('treats reportGone on a raw store as a no-op', async () => {
    await new RAMIndexCacheStore().reportGone([{ path: '/a', folder: false }])
  })
})

describe('the listing gate', () => {
  const row = (name: string): IndexEntry => new IndexEntry({ id: name, name, resourceType: 'file' })

  function gate(answer: boolean): [string[], (key: string) => Promise<boolean>] {
    const asked: string[] = []
    return [
      asked,
      (key) => {
        asked.push(key)
        return Promise.resolve(answer)
      },
    ]
  }

  function storeOf(kind: string): IndexCacheStore {
    const url = process.env.REDIS_URL
    return kind === 'ram'
      ? new RAMIndexCacheStore({ ttl: 600 })
      : new RedisIndexCacheStore({
          ttl: 600,
          ...(url === undefined ? {} : { url }),
          keyPrefix: `view-gate:${crypto.randomUUID()}:`,
        })
  }

  // Refusing is not dropping: the listing stays for the re-list to diff
  // against, and every reader already re-lists an EXPIRED answer.
  for (const kind of ['ram', 'redis']) {
    it.skipIf(kind === 'redis' && process.env.REDIS_URL === undefined).each([false, true])(
      `${kind}: a refused listing reads expired and stays stored (partial=%s)`,
      async (partial) => {
        const [asked, mayServeListing] = gate(false)
        const store = storeOf(kind)
        try {
          const view = new IndexView(store, new RAMFileCacheStore(), '/data', () => true, {
            mayServeListing,
          })
          if (partial) await view.setPartialDir('/data', [['a', row('a')]])
          else await view.setDir('/data', [['a', row('a')]])
          expect((await view.listDir('/data')).status).toBe(LookupStatus.EXPIRED)
          expect(asked).toEqual(['/data'])
          const stored = await store.listDir('/data')
          expect(partial ? stored.partialEntries : stored.entries).toEqual(['/data/a'])
        } finally {
          await store.close()
        }
      },
    )
  }

  function versionGate(answer: boolean): {
    asked: [string, string | null][]
    answer: boolean
    call: (key: string, version: string | null) => Promise<boolean>
  } {
    const spy = {
      asked: [] as [string, string | null][],
      answer,
      call: (key: string, version: string | null) => {
        spy.asked.push([key, version])
        return Promise.resolve(spy.answer)
      },
    }
    return spy
  }

  it('hands the gate the stored version', async () => {
    const spy = versionGate(true)
    const view = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/data',
      () => true,
      {
        mayServeListing: spy.call,
      },
    )
    await view.setDir('/data', [['a', row('a')]], undefined, { version: 'v1' })
    await view.setPartialDir('/data/p', [['b', row('b')]])
    await view.listDir('/data')
    await view.listDir('/data/p')
    expect(spy.asked).toEqual([
      ['/data', 'v1'],
      ['/data/p', null],
    ])
  })

  it('a refusal keeps the version for the next serve', async () => {
    const spy = versionGate(false)
    const store = storeOf('ram')
    try {
      const view = new IndexView(store, new RAMFileCacheStore(), '/data', () => true, {
        mayServeListing: spy.call,
      })
      await view.setDir('/data', [['a', row('a')]], undefined, { version: 'v1' })
      expect((await view.listDir('/data')).status).toBe(LookupStatus.EXPIRED)
      spy.answer = true
      const served = await view.listDir('/data')
      expect(served.entries).toEqual(['/data/a'])
      expect(served.version).toBe('v1')
      expect(spy.asked).toEqual([
        ['/data', 'v1'],
        ['/data', 'v1'],
      ])
    } finally {
      await store.clear()
      await store.close()
    }
  })

  it('passes a served listing through', async () => {
    const [, mayServeListing] = gate(true)
    const view = new IndexView(
      new RAMIndexCacheStore(),
      new RAMFileCacheStore(),
      '/data',
      () => true,
      { mayServeListing },
    )
    await view.setDir('/data', [['a', row('a')]])
    expect((await view.listDir('/data')).entries).toEqual(['/data/a'])
  })

  // A missing or expired listing is re-listed anyway; and an unowned or
  // absent key must stay NOT_FOUND, never become EXPIRED, since github
  // answers an EXPIRED re-read from its refill snapshot.
  it('asks only about a listing the store has', async () => {
    const [asked, mayServeListing] = gate(false)
    const store = new RAMIndexCacheStore()
    const owned = new Set(['/data', '/data/old'])
    const view = new IndexView(
      store,
      new RAMFileCacheStore(),
      '/data',
      (key) => owned.has(key) || key.startsWith('/data/x'),
      { mayServeListing },
    )
    expect((await view.listDir('/data/x')).status).toBe(LookupStatus.NOT_FOUND)
    await store.setDir('/data/old', [['a', row('a')]], new Date(Date.now() - 1000))
    expect((await view.listDir('/data/old')).status).toBe(LookupStatus.EXPIRED)
    expect((await view.listDir('/elsewhere')).status).toBe(LookupStatus.NOT_FOUND)
    expect(asked).toEqual([])
  })

  it('keeps a listing whose ownership went during the read NOT_FOUND', async () => {
    const [asked, mayServeListing] = gate(false)
    const store = new RAMIndexCacheStore()
    const owned = new Set(['/data'])
    await store.setDir('/data', [['a', row('a')]])
    const original = store.listDir.bind(store)
    vi.spyOn(store, 'listDir').mockImplementation(async (key) => {
      const result = await original(key)
      owned.clear()
      return result
    })
    const view = new IndexView(store, new RAMFileCacheStore(), '/data', (key) => owned.has(key), {
      mayServeListing,
    })
    expect((await view.listDir('/data')).status).toBe(LookupStatus.NOT_FOUND)
    expect(asked).toEqual([])
  })

  // Task 1.3's gate stats the backend; inside the mutation fence it would
  // hold every writer of the mount for that round trip.
  it('runs outside the fence', async () => {
    const cache = new RAMFileCacheStore()
    let enter = (): void => undefined
    let release = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const view = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => true, {
      mayServeListing: async () => {
        enter()
        await released
        return true
      },
    })
    await view.setDir('/data', [['a', row('a')]])
    const reading = view.listDir('/data')
    try {
      expect(await settleWithin(entered, 2000)).toBe('done')
      expect(
        await settleWithin(
          withCacheMutation(cache, () => Promise.resolve()),
          2000,
        ),
      ).toBe('done')
    } finally {
      release()
    }
    expect((await reading).entries).toEqual(['/data/a'])
  })

  // The note is what lets the same command trust the listing; noting it
  // before the store holds it would trust a listing another reader sees
  // half-written.
  it('notes every written folder after its write', async () => {
    const noted: string[] = []
    const store = new RAMIndexCacheStore()
    const original = store.setDir.bind(store)
    vi.spyOn(store, 'setDir').mockImplementation((...args) => {
      expect(noted).toEqual([])
      return original(...args)
    })
    const view = new IndexView(store, new RAMFileCacheStore(), '/data', () => true, {
      noteWritten: (folder) => noted.push(folder),
    })
    await view.setDir('/data', [['a', row('a')]])
    await view.setPartialDir('/data/p', [['b', row('b')]])
    view.seed(
      new Map([['/data/s/c', row('c')]]),
      new Map([
        ['/data/s', ['/data/s/c']],
        ['/data/t', []],
      ]),
      new Date(Date.now() + 3600000),
    )
    expect(noted).toEqual(['/data', '/data/p', '/data/s', '/data/t'])
  })
})

describe('a view probing for a subtree', () => {
  it.each([true, false])('answers from its store (owns=%s)', async (owned) => {
    const cache = new RAMFileCacheStore()
    const holding = new RAMIndexCacheStore()
    await holding.setDir('/data/dir/sub', [['f', ROW]])
    const view = new IndexView(holding, cache, '/data', () => owned)
    expect(await view.holdsSubtree('/data/dir')).toBe(true)
    const empty = new IndexView(new RAMIndexCacheStore(), cache, '/data', () => owned)
    expect(await empty.holdsSubtree('/data/dir')).toBe(false)
    await cache.close()
  })
})
