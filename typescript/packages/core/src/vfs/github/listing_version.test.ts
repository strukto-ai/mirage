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
import { shiftPerformanceNow } from '../../cache/_test_util.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import { LISTING_TRUST_WINDOW } from '../../cache/index/constants.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { RedisIndexCacheStore } from '../../cache/index/redis.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { runInCommandScope } from '../../cache/index/scope.ts'
import { FakeGitHub } from '../../core/github/_test_util.ts'
import { stat } from '../../core/github/stat.ts'
import { GitHubWalk } from '../../core/github/watch.ts'
import { ListingVersion, MountMode, PathSpec, ReadPolicy } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Reconciler } from '../../workspace/reconcile.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { GitHubVFS } from './github.ts'

const DEC = new TextDecoder()
const ROOT = new PathSpec({ vfsPath: '', virtual: '/gh', directory: '/gh' })
const LISTED = 'a.txt\nb.txt\nc.txt\n'
const GROWN = 'a.txt\nb.txt\nc.txt\nnew.txt\n'

let gh: FakeGitHub
const opened: Workspace[] = []

function three(): FakeGitHub {
  const hub = new FakeGitHub(
    Object.fromEntries(
      ['d1', 'd2', 'd3'].flatMap((d) => ['a', 'b', 'c'].map((n) => [`${d}/${n}.txt`, 'x\n'])),
    ),
  )
  vi.stubGlobal('fetch', hub.fetch)
  return hub
}

beforeEach(() => {
  gh = three()
})

afterEach(async () => {
  for (const w of opened.splice(0)) await w.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function vfsOf(ref = 'main'): Promise<GitHubVFS> {
  const vfs = await GitHubVFS.create({ token: 't', owner: 'o', repo: 'r', ref, baseUrl: gh.url })
  gh.log.length = 0
  return vfs
}

async function wsOf(
  vfs: GitHubVFS,
  policy: ReadPolicy = ReadPolicy.FRESH,
  index: IndexCacheStore | null = null,
): Promise<Workspace> {
  const w = new Workspace(
    {
      '/gh': new Mount(vfs, { mode: MountMode.READ, read: { policy, ttl: 600 } }),
      '/r': [new RAMVFS(), MountMode.WRITE],
    },
    { shellParser: await getTestParser() },
  )
  if (index !== null) {
    ;(w.registry.mountFor('/gh') as { indexStore: IndexCacheStore }).indexStore = index
  }
  opened.push(w)
  return w
}

async function out(w: Workspace, line: string): Promise<string> {
  const result = await w.shell(line)
  expect([result.exitCode, DEC.decode(result.stderr)], line).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

function storeOf(backend: string): IndexCacheStore {
  if (backend === 'ram') return new RAMIndexCacheStore()
  return new RedisIndexCacheStore({
    url: process.env.REDIS_URL ?? '',
    keyPrefix: `rows:${crypto.randomUUID()}:`,
  })
}

interface RedisInternals {
  client(): Promise<{ del(key: string): Promise<number> }>
  entryKey(path: string): string
}

// Drop one row the way eviction does: the listing that names it survives.
async function dropRow(store: IndexCacheStore, key: string): Promise<void> {
  if (store instanceof RAMIndexCacheStore) {
    await store.invalidateEntry(key)
    return
  }
  const redis = store as unknown as RedisInternals
  await (await redis.client()).del(redis.entryKey(key))
}

// Record every listing read the store answers from here on.
function countListDirs(store: IndexCacheStore): string[] {
  const reads: string[] = []
  const listDir = store.listDir.bind(store)
  vi.spyOn(store, 'listDir').mockImplementation((path: string) => {
    reads.push(path)
    return listDir(path)
  })
  return reads
}

// Keep one row missing however often it is refilled.
function rowStaysMissing(store: RAMIndexCacheStore, key: string): void {
  const get = store.get.bind(store)
  vi.spyOn(store, 'get').mockImplementation(async (path: string) =>
    path === key ? { status: LookupStatus.NOT_FOUND } : get(path),
  )
}

async function stored(w: Workspace, key = '/gh'): Promise<string | null> {
  return (await w.registry.mountFor('/gh').indexStore.listDir(key)).version ?? null
}

describe('github versions a listing by its head commit', () => {
  // Only the gate's check store wants the root's version, so a root stat
  // through the mount's own index names none and reads neither the index nor
  // the backend, however stale the trust is (it used to answer the stored one).
  it.each([true, false])(
    'names no root version through the mount index (scoped=%s)',
    async (scoped) => {
      const clock = shiftPerformanceNow()
      const vfs = await vfsOf()
      expect(vfs.listingVersion).toBe(ListingVersion.MOUNT)
      const w = await wsOf(vfs)
      await out(w, 'ls /gh')
      const version = await stored(w)
      clock.advance(LISTING_TRUST_WINDOW * 2000)
      gh.log.length = 0
      const index = w.registry.mountFor('/gh').index
      const reads = countListDirs(w.registry.mountFor('/gh').indexStore)
      const found = scoped
        ? await runInCommandScope(() => stat(vfs.accessor, ROOT, index))
        : await stat(vfs.accessor, ROOT, index)
      expect(version).not.toBeNull()
      expect(found.fingerprint).toBeNull()
      expect(reads).toEqual([])
      expect(gh.counts()).toEqual([0, 0, 0])
    },
  )

  // Only the gate's check store asks the head, so a root stat through the
  // mount's own index sends nothing, cold or listed (it used to ask once).
  it.each([ReadPolicy.BOUNDED, ReadPolicy.FRESH])(
    'asks nothing for a root stat before the first listing (%s)',
    async (policy) => {
      const w = await wsOf(await vfsOf(), policy)
      expect(await out(w, 'stat -c %n /gh')).toBe('/gh\n')
      expect(gh.counts()).toEqual([0, 0, 0])
      await out(w, 'ls /gh')
      gh.log.length = 0
      expect(await out(w, 'stat -c %n /gh')).toBe('/gh\n')
      expect(gh.counts()).toEqual([0, 0, 0])
    },
  )

  // An add outside mirage moves the head, so the next command's one check
  // misses and the tree is fetched once; a glob sees the file.
  it('sees an outside add after one check and one walk', async () => {
    const w = await wsOf(await vfsOf())
    await out(w, 'ls /gh')
    gh.set('d1/new.txt', 'new\n')
    gh.log.length = 0
    expect(await out(w, 'echo /gh/d1/*')).toBe(
      '/gh/d1/a.txt /gh/d1/b.txt /gh/d1/c.txt /gh/d1/new.txt\n',
    )
    expect(gh.counts()).toEqual([1, 1, 0])
  })

  // The version is the head the tree response itself named, so a commit
  // landing right after that response is a mismatch for the next command.
  it('catches a commit made after the tree response on the next command', async () => {
    const w = await wsOf(await vfsOf())
    gh.afterRecursive = () => {
      if (!gh.files.has('d1/new.txt')) gh.set('d1/new.txt', 'new\n')
    }
    expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
    gh.afterRecursive = null
    gh.log.length = 0
    expect(await out(w, 'ls /gh/d1')).toBe(GROWN)
    expect(gh.counts()).toEqual([1, 1, 0])
  })

  // A second workspace refills the index both share, so the first one's
  // in-memory tree is older than its index. ls answers from the index and
  // pays nothing for that; find and grep walk the tree, so they refill it.
  // Shared as one RAM store, or as two Redis stores over one server.
  const backends = process.env.REDIS_URL === undefined ? ['ram'] : ['ram', 'redis']
  it.each(backends)(
    'refills a tree older than a shared index before walking it (%s)',
    async (backend) => {
      const shared = new RAMIndexCacheStore()
      const keyPrefix = `shared:${crypto.randomUUID()}:`
      const store = (): IndexCacheStore =>
        backend === 'ram'
          ? shared
          : new RedisIndexCacheStore({ url: process.env.REDIS_URL ?? '', keyPrefix })
      const one = await wsOf(await vfsOf(), ReadPolicy.FRESH, store())
      const two = await wsOf(await vfsOf(), ReadPolicy.FRESH, store())
      await out(one, 'ls /gh')
      gh.set('d1/new.txt', 'new x\n')
      await out(two, 'ls /gh/d1')
      gh.log.length = 0
      expect(await out(one, 'ls /gh/d1')).toBe(GROWN)
      expect(gh.counts()).toEqual([1, 0, 0])
      gh.log.length = 0
      expect(await out(one, 'find /gh -name new.txt')).toBe('/gh/d1/new.txt\n')
      expect(gh.counts()).toEqual([1, 1, 0])
      expect(await out(one, 'grep -rl x /gh')).toContain('/gh/d1/new.txt')
    },
  )

  // A full-hex ref pins every listing: the stored version is the pin, so the
  // next command serves it with no request. Compared lowercased.
  it('serves a listing pinned to a commit with no request', async () => {
    const head = await gh.head()
    const vfs = await vfsOf(head.toUpperCase())
    expect(vfs.listingsPin).toBe(head)
    const w = await wsOf(vfs)
    expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
    expect(await stored(w)).toBe(head)
    gh.log.length = 0
    expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
    expect(gh.counts()).toEqual([0, 0, 0])
  })

  // Only a full SHA-1 or SHA-256 hex string names a commit; one short or one
  // long is a branch name, so it pins nothing.
  it.each([
    ['c'.repeat(64), 'c'.repeat(64)],
    ['c'.repeat(39), null],
    ['c'.repeat(41), null],
    ['c'.repeat(63), null],
    ['c'.repeat(65), null],
  ])('pins only a full-length hex ref (%s)', async (ref, pin) => {
    gh.ref = ref
    expect((await vfsOf(ref)).listingsPin).toBe(pin)
  })

  // A mount pinned to an older commit, over a store a `main` mount filled,
  // must not serve main's listing just because it is pinned.
  it("never serves another ref's listing to a pinned mount", async () => {
    const old = await gh.head()
    const shared = new RAMIndexCacheStore()
    const main = await wsOf(await vfsOf(), ReadPolicy.FRESH, shared)
    await out(main, 'ls /gh/d1')
    gh.set('d1/new.txt', 'new\n')
    expect(await out(main, 'ls /gh/d1')).toBe(GROWN)
    await main.close()
    const pinned = await wsOf(await vfsOf(old), ReadPolicy.FRESH, shared)
    gh.log.length = 0
    expect(await out(pinned, 'ls /gh/d1')).toBe(LISTED)
    expect(gh.count('dir')).toBe(1)
  })

  // A full-sha ref is served unchecked because github.com refuses a 40- or
  // 64-hex branch or tag name (an Enterprise host is assumed to as well). A
  // hex ref that answers another head is stored at that head, so it never
  // matches its pin and an outside change is seen.
  it('never serves a hex branch name as a pin', async () => {
    const ref = 'a'.repeat(40)
    gh.ref = ref
    const vfs = await vfsOf(ref)
    expect(vfs.listingsPin).toBe(ref)
    const w = await wsOf(vfs)
    expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
    gh.set('d1/new.txt', 'new\n')
    gh.log.length = 0
    expect(await out(w, 'ls /gh/d1')).toBe(GROWN)
    expect(gh.counts()).not.toEqual([0, 0, 0])
  })

  // A truncated tree stores no version, pinned or not, so it re-lists folder
  // by folder as it did before versions existed.
  it('re-lists a truncated pinned mount like an unpinned one', async () => {
    const costs: [number[], number][] = []
    for (const pinned of [false, true]) {
      gh = three()
      gh.truncatedRecursive = true
      const w = await wsOf(await vfsOf(pinned ? await gh.head() : 'main'))
      await out(w, 'ls /gh/d1')
      expect(await stored(w, '/gh/d1')).toBeNull()
      gh.log.length = 0
      expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
      costs.push([gh.counts(), gh.count('sha_dir')])
    }
    expect(costs[0]).toEqual(costs[1])
  })

  // A tree response that names no head stores no version, so the next
  // command re-lists exactly as before versions existed.
  it('stores no version for a response without a head', async () => {
    gh.dropSha = true
    const w = await wsOf(await vfsOf())
    await out(w, 'ls /gh')
    expect(await stored(w)).toBeNull()
    expect(await stored(w, '/gh/d1')).toBeNull()
    gh.log.length = 0
    await out(w, 'ls /gh/d1')
    expect(gh.counts()).toEqual([0, 1, 0])
  })

  // Tree walks check the version like a listing does, and refill on a miss.
  it.each(['find /gh', 'du -a /gh'])(
    '%s after an outside add checks then walks once',
    async (line) => {
      const w = await wsOf(await vfsOf())
      await out(w, 'ls /gh')
      gh.set('d1/new.txt', 'new\n')
      gh.log.length = 0
      expect(await out(w, line)).toContain('/gh/d1/new.txt')
      expect(gh.counts()).toEqual([1, 1, 0])
    },
  )

  // The watcher's walk reseats the tree, and stamps the head it answered, so
  // a revert back to the index's head still refills the walked tree.
  it.each([
    [ReadPolicy.BOUNDED, [0, 1, 0]],
    [ReadPolicy.FRESH, [1, 1, 0]],
  ])('carries the head a watched tree was walked at (%s)', async (policy, cost) => {
    const vfs = await vfsOf()
    const w = await wsOf(vfs, policy)
    await out(w, 'ls /gh')
    gh.set('d1/new.txt', 'new\n')
    for await (const entry of new GitHubWalk(vfs.accessor).walk(ROOT)) void entry
    expect(vfs.accessor.treeVersion).toBe(await gh.head())
    gh.files.delete('d1/new.txt')
    gh.log.length = 0
    expect(await out(w, 'find /gh -name new.txt')).toBe('')
    expect(gh.counts()).toEqual(cost)
  })

  // A backend that cannot be reached answers EXPIRED at the gate, warned,
  // and the listing stays stored for the re-list to diff.
  it('keeps the listing when the backend cannot be reached', async () => {
    const w = await wsOf(await vfsOf())
    await out(w, 'ls /gh')
    const mount = w.registry.mountFor('/gh')
    const before = await mount.indexStore.listDir('/gh/d1')
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rec = new Reconciler(w.cache, w.namespace)
    expect(
      await runInCommandScope(() => rec.mayServeListing(mount, '/gh/d1', before.version ?? null)),
    ).toBe(false)
    expect((await mount.indexStore.listDir('/gh/d1')).entries).toEqual(before.entries)
    expect(warn).toHaveBeenCalled()
  })

  // Eviction can drop a child's row while its listing survives. The store
  // still serves the listing; a stat or read of the listed child finds no row
  // and refills once, so it answers the child rather than a hole.
  const rowBackends = process.env.REDIS_URL === undefined ? ['ram'] : ['ram', 'redis']
  const rowCases = rowBackends.flatMap((backend) =>
    [ReadPolicy.BOUNDED, ReadPolicy.FRESH].map((policy) => [backend, policy] as const),
  )
  it.each(rowCases)(
    'refills once for a listed child without a row (%s, %s)',
    async (backend, policy) => {
      const store = storeOf(backend)
      const w = await wsOf(await vfsOf(), policy, store)
      await out(w, 'ls /gh')
      await dropRow(store, '/gh/d1/a.txt')
      gh.log.length = 0
      expect(await out(w, 'cat /gh/d1/a.txt')).toBe('x\n')
      expect(gh.count('recursive')).toBe(1)
      expect(await out(w, 'stat -c %n /gh/d1/a.txt')).toBe('/gh/d1/a.txt\n')
      expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
      expect(gh.count('recursive')).toBe(1)
    },
  )

  // A truncated tree has no whole listing to refill, so the folder that names
  // the evicted row is listed again on its own.
  it('re-lists the folder of a listed child without a row in a truncated tree', async () => {
    gh.truncatedRecursive = true
    const store = new RAMIndexCacheStore()
    const w = await wsOf(await vfsOf(), ReadPolicy.BOUNDED, store)
    expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
    await store.invalidateEntry('/gh/d1/a.txt')
    gh.log.length = 0
    expect(await out(w, 'cat /gh/d1/a.txt')).toBe('x\n')
    expect(gh.count('recursive')).toBe(0)
    expect(gh.count('sha_dir')).toBeGreaterThanOrEqual(1)
  })

  // A listed child whose row is still missing after the eviction refill is
  // absent, as it was before rows were checked: one refill per command, and
  // the retry inside the same stat does not refill again.
  it('refills once per command for a row the refill does not bring back', async () => {
    const store = new RAMIndexCacheStore()
    const w = await wsOf(await vfsOf(), ReadPolicy.FRESH, store)
    await out(w, 'ls /gh')
    rowStaysMissing(store, '/gh/d1/a.txt')
    for (const command of [1, 2]) {
      gh.log.length = 0
      const result = await w.shell('stat /gh/d1/a.txt')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('No such file')
      expect(gh.count('recursive'), String(command)).toBe(1)
    }
  })

  // The truncated arm re-lists the folder once per command, not twice.
  it('re-lists once per command for a row the re-list does not bring back', async () => {
    gh.truncatedRecursive = true
    const store = new RAMIndexCacheStore()
    const w = await wsOf(await vfsOf(), ReadPolicy.BOUNDED, store)
    expect(await out(w, 'ls /gh/d1')).toBe(LISTED)
    rowStaysMissing(store, '/gh/d1/a.txt')
    for (const command of [1, 2]) {
      gh.log.length = 0
      const result = await w.shell('stat /gh/d1/a.txt')
      expect(result.exitCode).toBe(1)
      expect(gh.count('recursive')).toBe(0)
      expect(gh.count('sha_dir'), String(command)).toBe(1)
    }
  })

  // A warm tree walk reads the root listing once: the version the liveness
  // probe read is the one the in-memory tree is matched against, and the root
  // stat find and du make reads nothing.
  it.each(['find /gh', 'du -a /gh'])('reads the root listing once for a warm %s', async (line) => {
    const w = await wsOf(await vfsOf(), ReadPolicy.BOUNDED)
    await out(w, 'ls -R /gh')
    await out(w, line)
    const reads = countListDirs(w.registry.mountFor('/gh').indexStore)
    gh.log.length = 0
    await out(w, line)
    expect(reads.filter((path) => path === '/gh')).toHaveLength(1)
    expect(gh.counts()).toEqual([0, 0, 0])
  })

  // A name the live listing does not hold is absent, and costs no refill.
  it.each(rowBackends)('answers an unlisted name absent without a refill (%s)', async (backend) => {
    const w = await wsOf(await vfsOf(), ReadPolicy.FRESH, storeOf(backend))
    await out(w, 'ls /gh')
    gh.log.length = 0
    const result = await w.shell('stat /gh/d1/zz.txt')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toContain('No such file')
    expect(gh.count('recursive')).toBe(0)
  })
})
