import { FileStat, FileType } from '../../types.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LookupStatus } from './config.ts'
import { RAMIndexCacheStore } from './ram.ts'
import { RedisIndexCacheStore } from './redis.ts'
import { IndexCacheStore } from './store.ts'
import { IndexView } from './view.ts'
import { RAMFileCacheStore } from '../file/ram.ts'

const REDIS_URL = process.env.REDIS_URL

function folder(name: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, fingerprint: name })
}

function entry(name = 'a'): FileStat {
  return new FileStat({
    name,
    type: FileType.FILE,
    size: 2,
    modified: '2026-09-05T10:55:39.123000Z',
    fingerprint: name,
    extra: { nested: { tags: ['x', 'y'] } },
  })
}

for (const backend of ['ram', 'redis']) {
  describe.skipIf(backend === 'redis' && REDIS_URL === undefined)(
    `${backend} index contract`,
    () => {
      let store: IndexCacheStore
      let keyPrefix: string
      // Every test lists under an hour's ttl, so a stalled runner cannot
      // expire a listing between two of its awaits; the one that waits on
      // the clock builds its own one-second store.
      function build(ttl = 3600): IndexCacheStore {
        return backend === 'ram'
          ? new RAMIndexCacheStore({ ttl })
          : new RedisIndexCacheStore({
              ...(REDIS_URL === undefined ? {} : { url: REDIS_URL }),
              keyPrefix,
              ttl,
            })
      }
      beforeEach(() => {
        keyPrefix = `contract:[${crypto.randomUUID()}]:`
        store = build()
      })
      afterEach(async () => {
        await store.clear()
        await store.close()
      })

      it.each([false, true])(
        'conditional replacement preserves listing and stamps: expired=%s',
        async (expired) => {
          const deadline = new Date(Date.now() + (expired ? -1000 : 3600000))
          await store.setDir('/dir', [['a', entry()]], deadline, { version: 'v1' })
          const listing = await store.listDir('/dir')
          expect(listing.status).toBe(expired ? LookupStatus.EXPIRED : undefined)
          const old = (await store.get('/dir/a')).entry

          if (old == null) throw new Error('missing seeded row')
          const replacement = entry('confirmed')
          expect(await store.replaceIfUnchanged('/dir/a', JSON.stringify(old), replacement)).toBe(
            true,
          )
          const current = (await store.get('/dir/a')).entry

          if (current == null) throw new Error('missing seeded row')
          expect(current).toEqual(replacement)
          expect(await store.listDir('/dir')).toEqual(listing)
          const pinned = replacement.with({ modified: 'pinned' })
          expect(await store.replaceIfUnchanged('/dir/a', JSON.stringify(current), pinned)).toBe(
            true,
          )
          expect((await store.get('/dir/a')).entry).toEqual(pinned)
          expect(await store.listDir('/dir')).toEqual(listing)
          expect(await store.replaceIfUnchanged('/dir/a', JSON.stringify(old), replacement)).toBe(
            false,
          )
          expect(await store.replaceIfUnchanged('/missing', JSON.stringify(old), replacement)).toBe(
            false,
          )
          expect(
            await IndexCacheStore.prototype.replaceIfUnchanged.call(
              store,
              '/dir/a',
              JSON.stringify(pinned),
              old,
            ),
          ).toBe(false)
          expect((await store.get('/dir/a')).entry).toEqual(pinned)
        },
      )

      it('conditional replacement observes pending seed', async () => {
        const old = entry().with({ modified: 'old' })
        await store.put('/dir/a', old)
        const seeded = old.with({ extra: { nested: { tags: ['changed'] } } })
        store.seed(
          new Map([['/dir/a', seeded]]),
          new Map([['/dir', ['/dir/a']]]),
          new Date(Date.now() + 3600000),
        )
        expect(
          await store.replaceIfUnchanged('/dir/a', JSON.stringify(old), entry('confirmed')),
        ).toBe(false)
        expect((await store.get('/dir/a')).entry).toEqual(seeded)
      })

      it.each([false, true])(
        'narrow mutation keeps siblings and demotes parent (window=%s)',
        async (window) => {
          await store.setDir(
            '/dir',
            [
              ['a', entry()],
              ['b', entry('b')],
            ],
            undefined,
            { version: 'v1', window },
          )
          await store.invalidateEntry('/dir/a')
          expect((await store.get('/dir/a')).status).toBe(LookupStatus.NOT_FOUND)
          expect((await store.get('/dir/b')).entry).toEqual(entry('b'))
          const listing = await store.listDir('/dir')
          expect(listing.entries ?? null).toBeNull()
          expect(listing.partialEntries).toEqual(['/dir/b'])
          expect(listing.version ?? null).toBeNull()
          expect(listing.window ?? false).toBe(false)
        },
      )

      it.each(['deadline', 'generation'])(
        'narrow mutation does not revive stale parent (%s)',
        async (state) => {
          const deadline = new Date(Date.now() + (state === 'deadline' ? -1000 : 3600000))
          await store.setDir(
            '/dir',
            [
              ['a', entry()],
              ['sub', folder('sub')],
            ],
            deadline,
          )
          await store.put('/dir/sub/stray', entry('stray'))
          if (state === 'generation') await store.invalidate()
          await store.invalidateEntry('/dir/a')
          expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
          await store.addEntry('/dir/new', entry('new'))
          expect((await store.listDir('/dir')).partialEntries).toEqual(['/dir/new'])
          expect(
            (await store.setDir('/dir', [['new', entry('new')]])).sort((a, b) =>
              a.path.localeCompare(b.path),
            ),
          ).toEqual([
            { path: '/dir/a', folder: false },
            { path: '/dir/sub', folder: true },
          ])
          expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
        },
      )

      it.each(['none', 'broad', 'prefix', 'add'])(
        'narrow tombstones survive partial overwrite (%s)',
        async (after) => {
          await store.setDir('/dir', [
            ['a', entry()],
            ['sub', folder('sub')],
          ])
          await store.put('/dir/sub/stray', entry('stray'))
          await store.put('/dir/sub/nested/keep', entry('keep'))
          await store.invalidateEntry('/dir/a')
          await store.setPartialDir('/dir', [['sub', entry('sub')]])
          if (after === 'broad') await store.invalidateDir('/dir')
          else if (after === 'prefix') await store.invalidatePrefix('/dir', ['/dir/sub/nested'])
          else if (after === 'add') await store.addEntry('/dir/sub', entry('sub'))
          expect(
            (
              await store.setDir('/dir', [['sub', entry('sub')]], undefined, {
                excluded: ['/dir/sub/nested'],
              })
            ).sort((a, b) => a.path.localeCompare(b.path)),
          ).toEqual([
            { path: '/dir/a', folder: false },
            { path: '/dir/sub', folder: true },
          ])
          expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
          expect((await store.get('/dir/sub/nested/keep')).entry).toEqual(entry('keep'))
        },
      )

      it('authoritative add preserves replaced folder evidence', async () => {
        await store.setDir('/dir', [['sub', folder('sub')]])
        await store.put('/dir/sub/stray', entry('stray'))
        await store.addEntry('/dir/sub', entry('sub'))
        await store.invalidateDir('/dir')
        expect(await store.setDir('/dir', [['sub', entry('sub')]])).toEqual([
          { path: '/dir/sub', folder: true },
        ])
        expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
      })

      it('concurrent narrow mutations merge history', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
          ['sub', folder('sub')],
        ])
        await store.put('/dir/sub/stray', entry('stray'))
        await Promise.all([store.invalidateEntry('/dir/a'), store.invalidateEntry('/dir/b')])
        expect((await store.listDir('/dir')).partialEntries).toEqual(['/dir/sub'])
        expect(
          (await store.setDir('/dir', [])).sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual([
          { path: '/dir/a', folder: false },
          { path: '/dir/b', folder: false },
          { path: '/dir/sub', folder: true },
        ])
      })

      it.each([false, true])(
        'split seeds classify rows from merged state (flushed=%s)',
        async (flushed) => {
          const deadline = new Date(Date.now() + 3600000)
          store.seed(new Map([['/dir/sub', folder('sub')]]), new Map(), deadline)
          if (flushed) expect((await store.get('/dir/sub')).entry).toEqual(folder('sub'))
          store.seed(new Map(), new Map([['/dir', ['/dir/sub']]]), deadline)
          expect((await store.listDir('/dir')).entries).toEqual(['/dir/sub'])
          expect((await store.get('/dir/sub')).entry).toEqual(folder('sub'))
        },
      )

      it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ])(
        'split seeds preserve child listing directory evidence (flushed=%s, parentFirst=%s)',
        async (flushed, parentFirst) => {
          const deadline = new Date(Date.now() + 3600000)
          const first = parentFirst
            ? new Map([['/dir', ['/dir/sub']]])
            : new Map([['/dir/sub', []]])
          const second = parentFirst
            ? new Map([['/dir/sub', []]])
            : new Map([['/dir', ['/dir/sub']]])
          store.seed(new Map(), first, deadline)
          if (flushed) await store.listDir(parentFirst ? '/dir' : '/dir/sub')
          store.seed(new Map(), second, deadline)
          expect((await store.listDir('/dir')).entries).toEqual(['/dir/sub'])
          await store.put('/dir/sub/stray', entry('stray'))
          await store.invalidateEntry('/dir/a')
          await store.invalidateDir('/dir/sub')
          await store.setPartialDir('/dir', [['sub', entry('sub')]])
          expect(await store.setDir('/dir', [['sub', entry('sub')]])).toEqual([
            { path: '/dir/sub', folder: true },
          ])
          expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
        },
      )

      it.each(
        ['seed', 'complete', 'partial', 'window'].flatMap((publication) =>
          ['listed', 'tombstone', 'absent'].map((prior) => [publication, prior]),
        ),
      )(
        'child listing publication preserves existing parent evidence (publication=%s, prior=%s)',
        async (publication, prior) => {
          if (prior !== 'absent') await store.setDir('/dir', [['sub', entry('sub')]])
          if (prior === 'tombstone') await store.invalidateEntry('/dir/sub')
          if (publication === 'seed') {
            store.seed(new Map(), new Map([['/dir/sub', []]]), new Date(Date.now() + 3600000))
            await store.listDir('/dir/sub')
          } else if (publication === 'partial') {
            await store.setPartialDir('/dir/sub', [])
          } else {
            await store.setDir('/dir/sub', [], undefined, { window: publication === 'window' })
          }
          await store.put('/dir/sub/stray', entry('stray'))
          await store.invalidateEntry('/dir/a')
          await store.invalidateDir('/dir/sub')
          await store.setPartialDir('/dir', [['sub', entry('sub')]])
          expect(await store.setDir('/dir', [['sub', entry('sub')]])).toEqual(
            prior === 'absent' ? [] : [{ path: '/dir/sub', folder: true }],
          )
          expect((await store.get('/dir/sub/stray')).status).toBe(
            prior === 'absent' ? undefined : LookupStatus.NOT_FOUND,
          )
        },
      )

      it.each([
        { window: false, offset: -1 },
        { window: false, offset: 3600 },
        { window: true, offset: -1 },
        { window: true, offset: 3600 },
      ])(
        'child directory proof preserves parent listing state (window=$window, offset=$offset)',
        async ({ window, offset }) => {
          const deadline = new Date(Date.now() + offset * 1000)
          await store.setDir('/dir', [['sub', entry('sub')]], deadline, { window, version: 'v1' })
          const before = await store.listDir('/dir')
          await store.setDir('/dir/sub', [])
          expect(await store.listDir('/dir')).toEqual(before)
        },
      )

      it.each(['seed', 'partial'])(
        'parent %s retains previously listed child directory',
        async (publication) => {
          await store.setDir('/dir/sub', [])
          await store.put('/dir/sub/stray', entry('stray'))
          if (publication === 'seed') {
            store.seed(
              new Map([['/dir/sub', entry('sub')]]),
              new Map([['/dir', ['/dir/sub']]]),
              new Date(Date.now() + 3600000),
            )
            await store.listDir('/dir')
          } else {
            await store.setPartialDir('/dir', [['sub', entry('sub')]])
          }
          await store.invalidateDir('/dir/sub')
          expect(await store.setDir('/dir', [['sub', entry('sub')]])).toEqual([
            { path: '/dir/sub', folder: true },
          ])
          expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
        },
      )

      it.each([false, true])(
        'narrow invalidation preserves own listing directory evidence (listed=%s)',
        async (listed) => {
          if (listed) await store.setDir('/dir', [['sub', entry('sub')]])
          await store.setDir('/dir/sub', [])
          await store.put('/dir/sub/stray', entry('stray'))
          await store.invalidateEntry('/dir/sub')
          await store.invalidateDir('/dir/sub')
          expect(await store.setDir('/dir', [])).toEqual([{ path: '/dir/sub', folder: true }])
          expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
        },
      )

      it('incoming authoritative row creates no prior membership', async () => {
        await store.addEntry('/dir/sub', folder('sub'))
        await store.invalidatePrefix('/dir')
        await store.put('/dir/sub', folder('sub'))
        expect(await store.setDir('/dir', [['a', entry()]])).toEqual([])
        expect((await store.get('/dir/sub')).entry).toEqual(folder('sub'))
      })

      it.each(['seed', 'complete', 'child-listing'])(
        'current %s membership creates no history after prefix forget',
        async (publication) => {
          if (publication === 'seed') {
            store.seed(
              new Map([['/dir/sub', folder('sub')]]),
              new Map([['/dir', ['/dir/sub']]]),
              new Date(Date.now() + 3600000),
            )
            await store.listDir('/dir')
          } else {
            await store.setDir('/dir', [['sub', folder('sub')]])
            if (publication === 'child-listing') await store.setDir('/dir/sub', [])
          }
          await store.invalidatePrefix('/dir')
          await store.put('/dir/sub', folder('sub'))
          await store.put('/dir/sub/stray', entry('stray'))
          expect(await store.setDir('/dir', [['a', entry()]])).toEqual([])
          expect((await store.get('/dir/sub')).entry).toEqual(folder('sub'))
          expect((await store.get('/dir/sub/stray')).entry).toEqual(entry('stray'))
        },
      )

      it('partial incoming file creates no history after prefix forget', async () => {
        await store.setPartialDir('/dir', [['new', entry('new')]])
        await store.invalidatePrefix('/dir')
        await store.put('/dir/new', entry('new'))
        expect(await store.setDir('/dir', [])).toEqual([])
        expect((await store.get('/dir/new')).entry).toEqual(entry('new'))
      })

      it.each([
        { replacement: 'put', expired: false },
        { replacement: 'put', expired: true },
        { replacement: 'add', expired: false },
        { replacement: 'add', expired: true },
      ])(
        '$replacement row replacement retains only required history (expired=$expired)',
        async ({ replacement, expired }) => {
          const deadline = new Date(Date.now() + (expired ? -1000 : 3600000))
          await store.setDir(
            '/dir',
            [
              ['changed', folder('changed')],
              ['kept', folder('kept')],
            ],
            deadline,
          )
          if (replacement === 'put') await store.put('/dir/changed', entry('changed'))
          else await store.addEntry('/dir/changed', entry('changed'))
          await store.invalidatePrefix('/dir')
          await store.put('/dir/kept', folder('kept'))
          await store.put('/dir/kept/stray', entry('stray'))
          const gone = await store.setDir('/dir', [['changed', entry('changed')]])
          const expected = [{ path: '/dir/changed', folder: true }]
          if (expired && replacement === 'add') expected.push({ path: '/dir/kept', folder: true })
          expect(gone.sort((a, b) => a.path.localeCompare(b.path))).toEqual(expected)
          expect((await store.get('/dir/kept/stray')).status).toBe(
            expected.length === 2 ? LookupStatus.NOT_FOUND : undefined,
          )
        },
      )

      const sub = (type: FileType): FileStat => new FileStat({ name: 'sub', type })
      const PRIORS = ['listed', 'invalidated', 'unlisted']
      it.each(PRIORS)('clears a directory replaced by a file (prior=%s)', async (prior) => {
        const old = sub(FileType.DIRECTORY)
        const next = sub(FileType.FILE)
        if (prior === 'unlisted') await store.put('/dir/sub', old)
        else await store.setDir('/dir', [['sub', old]])
        await store.setDir('/dir/sub', [['old', entry('old')]])
        await store.put('/dir/sub/unlisted', entry('unlisted'))
        await store.setDir('/dir/sub/nested', [['keep', entry('keep')]])
        await store.setDir('/dir/sub2', [['keep', entry('keep')]])
        if (prior === 'invalidated') await store.invalidateDir('/dir')
        expect(
          await store.setDir('/dir', [['sub', next]], undefined, {
            excluded: ['/dir/sub/nested'],
          }),
        ).toEqual([{ path: '/dir/sub', folder: true }])
        expect((await store.get('/dir/sub')).entry?.type).toBe(FileType.FILE)
        expect((await store.listDir('/dir')).entries).toEqual(['/dir/sub'])
        expect((await store.listDir('/dir/sub')).status).toBe(LookupStatus.NOT_FOUND)
        for (const path of ['/dir/sub/old', '/dir/sub/unlisted']) {
          expect((await store.get(path)).status).toBe(LookupStatus.NOT_FOUND)
        }
        for (const path of ['/dir/sub/nested', '/dir/sub2']) {
          expect((await store.listDir(path)).entries).toEqual([path + '/keep'])
        }
        expect(await store.setDir('/dir', [['sub', next]])).toEqual([])
      })

      // The folder's own listing was never cached, so only its row's type
      // says it was a folder.
      it.each(PRIORS)(
        'clears rows under a folder known by its row, replaced by a file (prior=%s)',
        async (prior) => {
          const old = sub(FileType.DIRECTORY)
          const next = sub(FileType.FILE)
          if (prior === 'unlisted') await store.put('/dir/sub', old)
          else await store.setDir('/dir', [['sub', old]])
          await store.put('/dir/sub/stray', entry('stray'))
          if (prior === 'invalidated') await store.invalidateDir('/dir')
          expect(await store.setDir('/dir', [['sub', next]])).toEqual([
            { path: '/dir/sub', folder: true },
          ])
          expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
        },
      )

      it.each(PRIORS)('preserves directory subtrees on re-list (prior=%s)', async (prior) => {
        const child = sub(FileType.DIRECTORY)
        if (prior !== 'unlisted') await store.setDir('/dir', [['sub', child]])
        await store.setDir('/dir/sub', [['keep', entry('keep')]])
        if (prior === 'invalidated') await store.invalidateDir('/dir')
        expect(await store.setDir('/dir', [['sub', child]])).toEqual([])
        expect((await store.listDir('/dir/sub')).entries).toEqual(['/dir/sub/keep'])
        expect((await store.get('/dir/sub/keep')).entry).toBeDefined()
        expect(await store.setDir('/dir', [])).toEqual([{ path: '/dir/sub', folder: true }])
        expect((await store.get('/dir/sub/keep')).status).toBe(LookupStatus.NOT_FOUND)
      })

      it('prefix invalidation preserves excluded subtrees', async () => {
        for (const path of ['/dir/nested', '/dir/nested/sub', '/dir/nested2']) {
          await store.put(path, entry(path))
          await store.setDir(path, [['a', entry()]])
        }
        await store.invalidatePrefix('/dir', ['/dir/nested'])
        for (const path of ['/dir/nested', '/dir/nested/sub']) {
          expect((await store.get(path)).entry).toBeDefined()
          expect((await store.listDir(path)).entries).toEqual([path + '/a'])
        }
        expect((await store.get('/dir/nested2/a')).status).toBe(LookupStatus.NOT_FOUND)
      })

      it('invalidates one entry without losing the re-list baseline', async () => {
        await store.put('/dir', entry('dir'))
        await store.setDir('/dir', [['a', entry('a')]])
        await store.invalidateEntry('/dir')
        expect((await store.get('/dir')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.listDir('/dir')).entries).toEqual(['/dir/a'])
        expect(await store.setDir('/dir', [])).toEqual([{ path: '/dir/a', folder: false }])
      })

      // Uncapped, the store's default; capped, whichever is shorter, since
      // that is how long a listing written through the view lives.
      it('lets a view report the lifetime its listings get', async () => {
        const cache = new RAMFileCacheStore()
        try {
          expect(new IndexView(store, cache, '/', () => true).ttl).toBe(3600)
          expect(new IndexView(store, cache, '/', () => true, { readTtl: 7200 }).ttl).toBe(3600)
          expect(new IndexView(store, cache, '/', () => true, { readTtl: 0.5 }).ttl).toBe(0.5)
        } finally {
          await cache.close()
        }
      })

      it('keeps missing, empty, fresh and expired listings distinct', async () => {
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
        await store.setDir('/dir', [])
        expect((await store.listDir('/dir')).entries).toEqual([])
        await store.setDir('/dir', [
          ['b', entry('b')],
          ['a', entry()],
        ])
        expect((await store.listDir('/dir')).entries).toEqual(['/dir/b', '/dir/a'])
        expect((await store.get('/dir/a')).entry).toEqual(entry())
        await store.invalidateDir('/dir')
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.get('/dir/a')).status).toBe(LookupStatus.NOT_FOUND)
      })

      it('expires a listing after the ttl', async () => {
        const short = build(1)
        try {
          expect(short.ttl).toBe(1)
          await short.setDir('/dir', [['a', entry()]])
          const got = (await short.get('/dir/a')).entry
          await new Promise((resolve) => setTimeout(resolve, 1100))
          expect((await short.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
          expect((await short.get('/dir/a')).entry).toEqual(got)
          await short.invalidateDir('/dir')
          expect((await short.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
          expect((await short.get('/dir/a')).status).toBe(LookupStatus.NOT_FOUND)
        } finally {
          await short.clear()
          await short.close()
        }
      })

      it.each([-1000, 0])('does not clamp deadline offset %s', async (offset) => {
        await store.setDir('/dir', [['a', entry()]], new Date(Date.now() + offset))
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
      })

      it('invalidates seeded listings without discarding metadata and can refill', async () => {
        const future = new Date(Date.now() + 3600000)
        store.seed(
          new Map([['/dir/a', entry()]]),
          new Map([
            ['/dir', ['/dir/a']],
            ['/empty', []],
          ]),
          future,
        )
        await store.invalidate()
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
        expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
        expect((await store.listDir('/absent')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.get('/dir/a')).entry).toBeDefined()
        await store.setDir('/dir', [], future)
        expect((await store.listDir('/dir')).entries).toEqual([])
        expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
      })

      it('merges seeds, copies input lists and persists them on close', async () => {
        const future = new Date(Date.now() + 3600000)
        const children = ['/one/a']
        store.seed(new Map([['/one/a', entry()]]), new Map([['/one', children]]), future)
        children.length = 0
        store.seed(
          new Map([['/two/b', entry('b')]]),
          new Map([
            ['/two', ['/two/b']],
            ['/empty', []],
          ]),
          future,
        )
        await store.close()
        await store.close()
        if (backend === 'redis') {
          store = new RedisIndexCacheStore({
            ...(REDIS_URL === undefined ? {} : { url: REDIS_URL }),
            keyPrefix,
          })
        }
        expect((await store.listDir('/one')).entries).toEqual(['/one/a'])
        expect((await store.listDir('/two')).entries).toEqual(['/two/b'])
        expect((await store.listDir('/empty')).entries).toEqual([])
        expect([...(await store.entries())].map(([path]) => path).sort()).toEqual([
          '/one/a',
          '/two/b',
        ])
      })

      it('makes invalidation visible to other clients', async () => {
        const peer =
          backend === 'ram'
            ? store
            : new RedisIndexCacheStore({
                ...(REDIS_URL === undefined ? {} : { url: REDIS_URL }),
                keyPrefix,
              })
        try {
          const future = new Date(Date.now() + 3600000)
          await store.setDir('/dir', [['a', entry()]], future)
          await peer.invalidate()
          expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
          await store.setDir('/dir', [], future)
          expect((await peer.listDir('/dir')).entries).toEqual([])
          await peer.invalidateDir('/dir')
          await store.invalidate()
          expect((await peer.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
        } finally {
          if (peer !== store) await peer.close()
        }
      })

      it('discards pending seeds on clear', async () => {
        store.seed(new Map([['/a', entry()]]), new Map([['/', ['/a']]]), new Date())
        await store.clear()
        expect(await store.entries()).toEqual(new Map())
        expect((await store.listDir('/')).status).toBe(LookupStatus.NOT_FOUND)
      })

      it('invalidates literal prefixes with path boundaries', async () => {
        const future = new Date(Date.now() + 3600000)
        for (const path of ['/a[1]', '/a[1]/nested', '/a1', '/a[1]-other']) {
          await store.setDir(path, [['a', entry()]], future)
        }
        await store.invalidatePrefix('/a[1]')
        for (const path of ['/a[1]', '/a[1]/nested']) {
          expect((await store.listDir(path)).status).toBe(LookupStatus.NOT_FOUND)
          expect((await store.get(path + '/a')).status).toBe(LookupStatus.NOT_FOUND)
        }
        for (const path of ['/a1', '/a[1]-other']) {
          expect((await store.listDir(path)).entries).toEqual([path + '/a'])
        }
      })

      it.each<[string, string[], [string, string] | null, string, string, boolean]>([
        ['descendant', ['/d/sub'], null, 'normal', '/d', true],
        ['own nonempty', ['/d'], null, 'nonempty', '/d', true],
        ['own empty', ['/d'], null, 'normal', '/d', true],
        ['TTL expired', ['/d/sub'], null, 'expired', '/d', true],
        ['generation expired', ['/d/sub'], null, 'invalidated', '/d', true],
        ['file row', [], ['/d', 'file'], 'normal', '/d', false],
        ['folder row', [], ['/d', 'folder'], 'normal', '/d', false],
        ['listing below file row', ['/d/sub'], ['/d', 'file'], 'normal', '/d', true],
        ['buried listings', ['/', '/d', '/d/sub'], null, 'buried', '/d', false],
        ['row below', [], ['/d/sub/f', 'file'], 'normal', '/d', false],
        ['lookalikes', ['/d-old/sub', '/d.bak', '/dx'], null, 'normal', '/d', false],
        ['empty root', [], null, 'normal', '/', false],
        ['populated root', ['/a'], null, 'normal', '/', true],
        ['trailing listing', ['/d/'], null, 'normal', '/d', true],
        ['trailing probe', ['/d/sub'], null, 'normal', '/d/', true],
        ['seeded', ['/d/sub'], null, 'seeded', '/d', true],
        ['partial', ['/d/sub'], null, 'partial', '/d', true],
      ])('holdsSubtree: %s', async (_name, listings, row, state, probe, expected) => {
        if (row !== null) {
          const kind = row[1] === 'folder' ? FileType.DIRECTORY : FileType.FILE
          await store.put(row[0], new FileStat({ name: 'row', type: kind }))
        }
        if (state === 'seeded') {
          store.seed(
            new Map(),
            new Map(listings.map((path) => [path, []])),
            new Date(Date.now() + 3600000),
          )
        } else {
          for (const path of listings) {
            if (state === 'partial') {
              await store.setPartialDir(path, [['f', entry('f')]])
            } else {
              const deadline = state === 'expired' ? new Date(Date.now() - 1000) : undefined
              await store.setDir(path, state === 'nonempty' ? [['f', entry('f')]] : [], deadline)
            }
          }
        }
        if (state === 'invalidated') await store.invalidate()
        if (state === 'buried') {
          for (const path of [...listings].reverse()) await store.invalidateDir(path)
        }
        expect(await store.holdsSubtree(probe)).toBe(expected)
      })

      it('evicts nothing on a first listing', async () => {
        expect(await store.setDir('/dir', [['a', entry()]])).toEqual([])
      })

      it('evicts the rows a re-list no longer names', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
        ])
        expect(await store.setDir('/dir', [['b', entry('b')]])).toEqual([
          { path: '/dir/a', folder: false },
        ])
        expect((await store.get('/dir/a')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.get('/dir/b')).entry).toBeDefined()
        expect((await store.listDir('/dir')).entries).toEqual(['/dir/b'])
      })

      it('evicts against an expired listing too', async () => {
        const past = new Date(Date.now() - 1000)
        await store.setDir(
          '/dir',
          [
            ['a', entry()],
            ['b', entry('b')],
          ],
          past,
        )
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
        expect(await store.setDir('/dir', [['b', entry('b')]])).toEqual([
          { path: '/dir/a', folder: false },
        ])
        expect((await store.get('/dir/a')).status).toBe(LookupStatus.NOT_FOUND)
      })

      it('drops the subtree of a folder a re-list no longer names', async () => {
        await store.setDir('/dir', [
          ['sub', folder('sub')],
          ['f', entry('f')],
        ])
        await store.setDir('/dir/sub', [
          ['x', entry('x')],
          ['deep', folder('deep')],
        ])
        await store.setDir('/dir/sub/deep', [['y', entry('y')]])
        await store.setDir('/dir/sub2', [['z', entry('z')]])
        expect(await store.setDir('/dir', [['f', entry('f')]])).toEqual([
          { path: '/dir/sub', folder: true },
        ])
        for (const path of ['/dir/sub', '/dir/sub/x', '/dir/sub/deep/y']) {
          expect((await store.get(path)).status).toBe(LookupStatus.NOT_FOUND)
        }
        for (const path of ['/dir/sub', '/dir/sub/deep']) {
          expect((await store.listDir(path)).status).toBe(LookupStatus.NOT_FOUND)
        }
        expect((await store.listDir('/dir/sub2')).entries).toEqual(['/dir/sub2/z'])
        expect((await store.get('/dir/sub2/z')).entry).toBeDefined()
      })

      it('evicts nothing on a partial listing', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
        ])
        await store.setPartialDir('/dir', [['b', entry('b')]])
        expect((await store.get('/dir/a')).entry).toBeDefined()
      })

      // A window names what to show, not every child: dropping out of it is
      // not deletion, so the row stays while the listing is served whole.
      it('evicts nothing on a window listing', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
        ])
        expect(await store.setDir('/dir', [['b', entry('b')]], null, { window: true })).toEqual([])
        expect((await store.get('/dir/a')).entry).toBeDefined()
        const listing = await store.listDir('/dir')
        expect(listing.entries).toEqual(['/dir/b'])
        // It is kept a window, so nothing reads it as proof of absence; a
        // complete listing after it is no window.
        expect(listing.window).toBe(true)
        await store.setDir('/dir', [['b', entry('b')]])
        expect((await store.listDir('/dir')).window).toBe(false)
      })

      // The partial listing never claimed "a", so a later full listing has
      // no evidence that "a" went away.
      it('diffs a full re-list over a partial only against what it named', async () => {
        await store.put('/dir/a', entry())
        await store.setPartialDir('/dir', [['b', entry('b')]])
        expect(await store.setDir('/dir', [])).toEqual([{ path: '/dir/b', folder: false }])
        expect((await store.get('/dir/a')).entry).toBeDefined()
      })

      it('still evicts on a re-list after invalidate', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
        ])
        await store.invalidate()
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
        expect(await store.setDir('/dir', [['b', entry('b')]])).toEqual([
          { path: '/dir/a', folder: false },
        ])
      })

      it('diffs a re-list against a pending seed', async () => {
        store.seed(
          new Map([
            ['/dir/a', entry()],
            ['/dir/b', entry('b')],
          ]),
          new Map([['/dir', ['/dir/a', '/dir/b']]]),
          new Date(Date.now() + 3600000),
        )
        expect(await store.setDir('/dir', [['b', entry('b')]])).toEqual([
          { path: '/dir/a', folder: false },
        ])
      })

      // Classified by whether it holds a listing, not by its row's type.
      it('treats a dropped listed child without a folder row as a folder', async () => {
        await store.setDir('/dir', [['sub', entry('sub')]])
        await store.setDir('/dir/sub', [['x', entry('x')]])
        expect(await store.setDir('/dir', [])).toEqual([{ path: '/dir/sub', folder: true }])
        expect((await store.get('/dir/sub/x')).status).toBe(LookupStatus.NOT_FOUND)
      })

      // Dropping a listing (a warm, a mutation) must not throw away what the
      // next re-list compares against.
      it('still evicts on a re-list after invalidateDir', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['sub', folder('sub')],
        ])
        await store.invalidateDir('/dir')
        expect((await store.listDir('/dir')).status).toBe(LookupStatus.NOT_FOUND)
        expect(await store.setDir('/dir', [])).toEqual([
          { path: '/dir/a', folder: false },
          { path: '/dir/sub', folder: true },
        ])
        expect(await store.setDir('/dir', [])).toEqual([])
      })

      it('evicts nothing on a window after invalidateDir', async () => {
        await store.setDir('/dir', [['a', entry()]])
        await store.invalidateDir('/dir')
        expect(await store.setDir('/dir', [], null, { window: true })).toEqual([])
        expect(await store.setDir('/dir', [])).toEqual([])
      })

      it('keeps the tombstone across a partial after invalidateDir', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
        ])
        await store.invalidateDir('/dir')
        await store.setPartialDir('/dir', [['b', entry('b')]])
        expect(await store.setDir('/dir', [['b', entry('b')]])).toEqual([
          { path: '/dir/a', folder: false },
        ])
      })

      it('preserves the full baseline across repeated partial invalidation', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['sub', folder('sub')],
          ['b', entry('b')],
        ])
        await store.setDir('/dir/sub', [['old', entry('old')]])
        await store.invalidateDir('/dir')
        await store.setPartialDir('/dir', [
          ['b', entry('b')],
          ['c', entry('c')],
        ])
        await store.invalidateDir('/dir')
        const gone = await store.setDir('/dir', [['b', entry('b')]])
        expect(gone.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: '/dir/a', folder: false },
          { path: '/dir/c', folder: false },
          { path: '/dir/sub', folder: true },
        ])
        expect((await store.get('/dir/sub/old')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.listDir('/dir')).entries).toEqual(['/dir/b'])
      })

      it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ])(
        'preserves folder evidence with repeated invalidation=%s and retained=%s',
        async (invalidateAgain, retained) => {
          await store.setDir('/dir', [['sub', folder('sub')]])
          await store.put('/dir/sub/orphan', entry('orphan'))
          await store.invalidateDir('/dir')
          await store.setPartialDir('/dir', [['sub', entry('sub')]])
          if (invalidateAgain) await store.invalidateDir('/dir')
          expect(await store.setDir('/dir', retained ? [['sub', entry('sub')]] : [])).toEqual([
            { path: '/dir/sub', folder: true },
          ])
          expect((await store.get('/dir/sub/orphan')).status).toBe(LookupStatus.NOT_FOUND)
          if (retained) expect((await store.get('/dir/sub')).entry?.type).toBe(FileType.FILE)
          else expect((await store.get('/dir/sub')).status).toBe(LookupStatus.NOT_FOUND)
        },
      )

      // A warm resolving a folder drops its parent's listing and then the
      // folder's own prefix before listing it; the evidence has to survive.
      it('keeps an existing tombstone across invalidatePrefix', async () => {
        await store.setDir('/dir', [
          ['a', entry()],
          ['b', entry('b')],
        ])
        await store.invalidateDir('/dir')
        await store.invalidatePrefix('/dir')
        expect(await store.setDir('/dir', [['a', entry()]])).toEqual([
          { path: '/dir/b', folder: false },
        ])
      })

      function peer(): IndexCacheStore {
        return backend === 'ram' ? store : build()
      }

      it('stamps every folder a seed writes with its version', async () => {
        const future = new Date(Date.now() + 3_600_000)
        store.seed(
          new Map([
            ['/repo/a', entry()],
            ['/repo/sub', folder('sub')],
            ['/repo/sub/b', entry('b')],
          ]),
          new Map([
            ['/repo', ['/repo/a', '/repo/sub']],
            ['/repo/sub', ['/repo/sub/b']],
          ]),
          future,
          'v1',
        )
        await store.close()
        store = peer()
        expect((await store.listDir('/repo')).version).toBe('v1')
        expect((await store.listDir('/repo/sub')).version).toBe('v1')
      })

      it('clears the version on an unversioned re-list', async () => {
        await store.setDir('/dir', [['a', entry()]], undefined, { version: 'v1' })
        expect((await store.listDir('/dir')).version).toBe('v1')
        await store.setDir('/dir', [['a', entry()]])
        const listing = await store.listDir('/dir')
        expect(listing.entries).toEqual(['/dir/a'])
        expect(listing.version).toBeNull()
      })

      it('never lets a partial listing inherit the version', async () => {
        await store.setDir('/dir', [['a', entry()]], undefined, { version: 'v1' })
        await store.setPartialDir('/dir', [['b', entry('b')]])
        const listing = await store.listDir('/dir')
        expect(listing.partialEntries).toEqual(['/dir/b'])
        expect(listing.version).toBeNull()
      })

      it('clears the version on an unversioned seed', async () => {
        const future = new Date(Date.now() + 3_600_000)
        const rows = new Map([['/dir/a', entry()]])
        const children = new Map([['/dir', ['/dir/a']]])
        store.seed(rows, children, future, 'v1')
        expect((await store.listDir('/dir')).version).toBe('v1')
        store.seed(rows, children, future, null)
        const listing = await store.listDir('/dir')
        expect(listing.entries).toEqual(['/dir/a'])
        expect(listing.version).toBeNull()
      })

      it('keeps rows only put wrote', async () => {
        await store.put('/dir/p', entry('p'))
        await store.setDir('/dir', [['a', entry()]])
        expect(await store.setDir('/dir', [])).toEqual([{ path: '/dir/a', folder: false }])
        expect((await store.get('/dir/p')).entry).toBeDefined()
      })
    },
  )
}
