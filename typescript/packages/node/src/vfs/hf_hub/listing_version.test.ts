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

import { LookupStatus } from '@struktoai/mirage-core/cache/index/config'
import { LISTING_TRUST_WINDOW } from '@struktoai/mirage-core/cache/index/constants'
import { ListingCheckStore, RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { RedisIndexCacheStore } from '@struktoai/mirage-core/cache/index/redis'
import { runInCommandScope } from '@struktoai/mirage-core/cache/index/scope'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { FileStat } from '@struktoai/mirage-core/types'
import { FileType, MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { Reconciler } from '@struktoai/mirage-core/workspace/reconcile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { FakeHub, serveHub } from '../../core/hf_hub/_test_util.ts'
import { stat } from '../../core/hf_hub/stat.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const ROOT = new PathSpec({ vfsPath: '', virtual: '/m', directory: '/m' })
const LISTED = 'b.txt\n'
const GROWN = 'b.txt\nnew.txt\n'

let hubs: FakeHub[] = []
let workspaces: Workspace[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(workspaces.map((w) => w.close()))
  workspaces = []
  await Promise.all(hubs.map((hub) => hub.close()))
  hubs = []
})

async function hubOf(): Promise<FakeHub> {
  const fake = new FakeHub()
  fake.files().set('a.txt', ENC.encode('alpha\n'))
  fake.files().set('docs/sub/b.txt', ENC.encode('bravo\n'))
  hubs.push(fake)
  return serveHub(fake)
}

function vfsOf(fake: FakeHub, revision?: string): Promise<BaseVFS> {
  const config: Record<string, unknown> = { repo_id: 'acme/widget', endpoint: fake.url }
  if (revision !== undefined) config.revision = revision
  return buildVfs('hf_models', config)
}

function prefixedOf(fake: FakeHub, keyPrefix?: string, revision?: string): Promise<BaseVFS> {
  const config: Record<string, unknown> = { repo_id: 'acme/widget', endpoint: fake.url }
  if (keyPrefix !== undefined) config.key_prefix = keyPrefix
  if (revision !== undefined) config.revision = revision
  return buildVfs('hf_models', config)
}

function wsOf(vfs: BaseVFS, index: IndexCacheStore | null = null): Workspace {
  const w = new Workspace({
    '/m': new Mount(vfs, { mode: MountMode.READ, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
    '/r': [new RAMVFS(), MountMode.WRITE],
  })
  if (index !== null) {
    ;(w.registry.mountFor('/m') as { indexStore: IndexCacheStore }).indexStore = index
  }
  workspaces.push(w)
  return w
}

async function out(w: Workspace, line: string): Promise<string> {
  const result = await w.shell(line)
  expect([result.exitCode, DEC.decode(result.stderr)], line).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

function counts(fake: FakeHub): number[] {
  return [
    fake.count('revision'),
    fake.count('tree'),
    fake.count('paths_info'),
    fake.count('resolve'),
  ]
}

function revs(fake: FakeHub, route: string): string[] {
  return [...new Set(fake.log.filter(([name]) => name === route).map(([, , rev]) => rev))]
}

function add(fake: FakeHub): void {
  fake.files().set('docs/sub/new.txt', ENC.encode('new\n'))
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

async function stored(w: Workspace, key = '/m'): Promise<string | null> {
  return (await w.registry.mountFor('/m').indexStore.listDir(key)).version ?? null
}

function accessorOf(vfs: BaseVFS): HfHubAccessor {
  return vfs.accessor as HfHubAccessor
}

describe('hf_hub versions a listing by its head commit', () => {
  it('costs one revision for an unchanged second command', async () => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    await out(w, 'ls /m')
    fake.log.length = 0
    expect(await out(w, 'ls /m/docs/sub')).toBe(LISTED)
    expect(counts(fake)).toEqual([1, 0, 0, 0])
  })

  // The gate's check misses, and the refill asks the head once more for the
  // commit it walks the tree at.
  it('checks then walks once for a changed second command', async () => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    await out(w, 'ls /m')
    add(fake)
    fake.log.length = 0
    expect(await out(w, 'ls /m/docs/sub')).toBe(GROWN)
    expect(counts(fake)).toEqual([2, 1, 0, 0])
  })

  it.each(['find /m -type f', 'ls -R /m'])('sees an outside add on a walk: %s', async (line) => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    await out(w, 'ls /m')
    fake.log.length = 0
    expect(await out(w, line)).not.toContain('new.txt')
    expect(counts(fake)).toEqual([1, 0, 0, 0])
    add(fake)
    fake.log.length = 0
    expect(await out(w, line)).toContain('new.txt')
    expect(counts(fake)).toEqual([2, 1, 0, 0])
  })

  // Repeated root stats on a mount that has not listed send nothing, and a
  // fresh one's cold root stat sends nothing either: only the gate's check
  // store asks the head.
  it('sends no request for a cold root stat', async () => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    for (let i = 0; i < 5; i++) expect((await w.vfs.stat('/m')).type).toBe(FileType.DIRECTORY)
    expect(await out(w, 'stat -c %n /m')).toBe('/m\n')
    expect(counts(fake)).toEqual([0, 0, 0, 0])
  })

  // A second mount over a warm shared store has not loaded its tree; the
  // gate's root stat, through its check store, asks the head once and never
  // walks or loads the tree.
  it('never walks for a root stat through the check store', async () => {
    const fake = await hubOf()
    const shared = new RAMIndexCacheStore({ ttl: 600 })
    const one = wsOf(await vfsOf(fake), shared)
    const twoVfs = await vfsOf(fake)
    const two = wsOf(twoVfs, shared)
    await out(one, 'ls /m')
    fake.log.length = 0
    const found = (await two.mount('/m').callKeyed('stat', ROOT, [], {
      index: new ListingCheckStore(),
    })) as FileStat
    expect(found.fingerprint).toBe(fake.head())
    expect(counts(fake)).toEqual([1, 0, 0, 0])
    expect(accessorOf(twoVfs).treeLoaded).toBe(false)
  })

  // Only the gate's check store wants the root's version, so a root stat
  // through the mount's own index names none and reads neither the index nor
  // the backend, however stale the trust is (it used to answer the stored one).
  it('names no root version through the mount index', async () => {
    const real = performance.now.bind(performance)
    let offset = 0
    vi.spyOn(performance, 'now').mockImplementation(() => real() + offset)
    const fake = await hubOf()
    const vfs = await vfsOf(fake)
    const w = wsOf(vfs)
    await out(w, 'ls /m')
    const version = await stored(w)
    offset += LISTING_TRUST_WINDOW * 2000
    fake.log.length = 0
    const index = w.registry.mountFor('/m').index
    const reads = countListDirs(w.registry.mountFor('/m').indexStore)
    const found = await runInCommandScope(() => stat(accessorOf(vfs), ROOT, index))
    expect(version).not.toBeNull()
    expect(found.fingerprint).toBeNull()
    expect(reads).toEqual([])
    expect(counts(fake)).toEqual([0, 0, 0, 0])
  })

  // A refused head names no version, and the root stat never falls into a
  // refill of the throwaway index.
  it.each([
    [404, 'RevisionNotFound'],
    [401, ''],
  ] as [number, string][])(
    'names no version and walks nothing for a refused head (%s)',
    async (status, code) => {
      const fake = await hubOf()
      const vfs = await vfsOf(fake)
      const w = wsOf(vfs)
      await out(w, 'ls /m')
      fake.fail.set('revision', [status, code])
      fake.log.length = 0
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const found = await stat(accessorOf(vfs), ROOT, new ListingCheckStore())
      expect(found.fingerprint).toBeNull()
      expect([fake.count('revision'), fake.count('tree')]).toEqual([1, 0])
      // Said on stderr, the way Python logs it.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^head of \S+ not answered: /)
      warn.mockRestore()
    },
  )

  // With no index at all (the null index), the root names no version and
  // asks nothing (it used to ask the head once).
  it('asks nothing for a root stat with no index', async () => {
    const fake = await hubOf()
    const vfs = await vfsOf(fake)
    const found = await stat(accessorOf(vfs), ROOT, undefined)
    expect(found.fingerprint).toBeNull()
    expect(counts(fake)).toEqual([0, 0, 0, 0])
  })

  // A mount at an older commit's revision, over a store a `main` mount
  // filled, must not serve main's listing.
  it("never serves another revision's listing at an older-commit revision", async () => {
    const fake = await hubOf()
    const old = fake.head()
    const shared = new RAMIndexCacheStore({ ttl: 600 })
    const main = wsOf(await vfsOf(fake), shared)
    await out(main, 'ls /m/docs/sub')
    add(fake)
    expect(await out(main, 'ls /m/docs/sub')).toBe(GROWN)
    await main.close()
    const older = wsOf(await vfsOf(fake, old), shared)
    fake.log.length = 0
    expect(await out(older, 'ls /m/docs/sub')).toBe(LISTED)
    expect(counts(fake)).toEqual([2, 1, 0, 0])
    fake.log.length = 0
    expect(await out(older, 'ls /m/docs/sub')).toBe(LISTED)
    expect(counts(fake)).toEqual([1, 0, 0, 0])
  })

  // An hf mount checks its head every command, even at a full-sha revision:
  // nothing it can learn once says the name will keep resolving to that
  // commit, so a branch named like it, made after the mount listed, is seen
  // on the next command.
  it('checks its head every command, even at a full-sha revision', async () => {
    const fake = await hubOf()
    const head = fake.head()
    const w = wsOf(await vfsOf(fake, head))
    expect(await out(w, 'ls /m/docs/sub')).toBe(LISTED)
    expect(await stored(w)).toBe(head)
    fake.log.length = 0
    expect(await out(w, 'ls /m/docs/sub')).toBe(LISTED)
    expect(counts(fake)).toEqual([1, 0, 0, 0])
    add(fake)
    fake.branches.add(head)
    fake.log.length = 0
    expect(await out(w, 'ls /m/docs/sub')).toBe(GROWN)
    expect(counts(fake)).toEqual([2, 1, 0, 0])
  })

  // A commit landing between the head and the tree walk: the tree is walked
  // at the head that was named, so the rows match their version, and the
  // next command's check sees the change.
  it('catches a commit between the head and the walk on the next command', async () => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    const old = fake.head()
    fake.afterRevision = () => {
      add(fake)
    }
    expect(await out(w, 'ls /m/docs/sub')).toBe(LISTED)
    fake.afterRevision = null
    expect(revs(fake, 'tree')).toEqual([old])
    expect(await stored(w)).toBe(old)
    fake.log.length = 0
    expect(await out(w, 'ls /m/docs/sub')).toBe(GROWN)
    expect(counts(fake)).toEqual([2, 1, 0, 0])
  })

  // A revision the Hub does not know: the refusal wording is the one the
  // tree walk gave before the head was asked first.
  it('reads a bad revision as permission denied', async () => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake, 'f'.repeat(40)))
    const ls = await w.shell('ls /m')
    expect([ls.exitCode, DEC.decode(ls.stderr)]).toEqual([
      2,
      "ls: cannot open directory '/m': Permission denied\n",
    ])
    const cat = await w.shell('cat /m/a.txt')
    expect([cat.exitCode, DEC.decode(cat.stderr)]).toEqual([
      1,
      'cat: /m/a.txt: Permission denied\n',
    ])
    expect(await out(w, 'stat -c %n /m')).toBe('/m\n')
  })

  // Index keys are mount-relative, so two mounts of one repository with
  // different key prefixes over one shared store must not share a version:
  // the second mount's check would match, and it would serve the first one's
  // subtree as its own root.
  it.each([false, true])(
    'keeps shared listings apart by key prefix (fullSha=%s)',
    async (fullSha) => {
      const fake = await hubOf()
      const shared = new RAMIndexCacheStore({ ttl: 600 })
      const revision = fullSha ? fake.head() : undefined
      const sub = wsOf(await prefixedOf(fake, 'docs/', revision), shared)
      const whole = wsOf(await prefixedOf(fake, undefined, revision), shared)
      expect(await out(sub, 'ls /m')).toBe('sub\n')
      expect(await out(whole, 'ls /m')).toBe('a.txt\ndocs\n')
      expect(await out(sub, 'ls /m')).toBe('sub\n')
      expect(await out(whole, 'ls /m/docs/sub')).toBe(LISTED)
    },
  )

  // The composed version is what the root stat names, so the gate's check
  // still matches what a prefixed mount's fill stored, and a mount with no
  // key prefix keeps the plain head.
  it('checks the version a prefixed mount stored', async () => {
    const fake = await hubOf()
    const w = wsOf(await prefixedOf(fake, 'docs/'))
    await out(w, 'ls /m')
    const version = await stored(w)
    expect(version).not.toBeNull()
    expect(version).not.toBe(fake.head())
    fake.log.length = 0
    expect(await out(w, 'ls /m')).toBe('sub\n')
    expect(counts(fake)).toEqual([1, 0, 0, 0])
    await w.close()
    const plain = wsOf(await prefixedOf(fake, undefined))
    await out(plain, 'ls /m')
    expect(await stored(plain)).toBe(fake.head())
  })

  // An hf outage is a transport failure, not a programming error: the gate
  // answers EXPIRED, warned, and the listing stays stored for the re-list.
  it('keeps the listing when the Hub cannot be reached', async () => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    await out(w, 'ls /m')
    const mount = w.registry.mountFor('/m')
    const before = await mount.indexStore.listDir('/m/docs/sub')
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const rec = new Reconciler(w.cache, w.namespace)
    const verdict = runInCommandScope(() =>
      rec.mayServeListing(mount, '/m/docs/sub', before.version ?? null),
    )
    await vi.runAllTimersAsync()
    expect(await verdict).toBe(false)
    vi.useRealTimers()
    expect((await mount.indexStore.listDir('/m/docs/sub')).entries).toEqual(before.entries)
    expect(warn).toHaveBeenCalled()
  })

  // A FUSE or programmatic read belongs to no command: it trusts a listing
  // for the window, then pays one version check, never a tree walk.
  it('checks once past the window on an unscoped read', async () => {
    const real = performance.now.bind(performance)
    let offset = 0
    vi.spyOn(performance, 'now').mockImplementation(() => real() + offset)
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake))
    await out(w, 'ls /m')
    fake.log.length = 0
    expect(await w.vfs.readdir('/m/docs/sub')).toEqual(['/m/docs/sub/b.txt'])
    await w.vfs.stat('/m/docs/sub/b.txt')
    expect(counts(fake)).toEqual([0, 0, 0, 0])
    offset += LISTING_TRUST_WINDOW * 1000
    await w.vfs.readdir('/m/docs/sub')
    await w.vfs.stat('/m/docs/sub/b.txt')
    expect(counts(fake)).toEqual([1, 0, 0, 0])
  })

  // Eviction can drop a child's row while its listing survives. The store
  // still serves the listing; a stat or read of the listed child finds no row
  // and refills once, so it answers the child rather than a hole.
  const rowBackends = process.env.REDIS_URL === undefined ? ['ram'] : ['ram', 'redis']
  it.each(rowBackends)('refills once for a listed child without a row (%s)', async (backend) => {
    const fake = await hubOf()
    const store = storeOf(backend)
    const w = wsOf(await vfsOf(fake), store)
    await out(w, 'ls /m')
    await dropRow(store, '/m/docs/sub/b.txt')
    fake.log.length = 0
    expect(await out(w, 'cat /m/docs/sub/b.txt')).toBe('bravo\n')
    expect(fake.count('tree')).toBe(1)
    expect(await out(w, 'stat -c %n /m/docs/sub/b.txt')).toBe('/m/docs/sub/b.txt\n')
    expect(await out(w, 'ls /m/docs/sub')).toBe(LISTED)
    expect(fake.count('tree')).toBe(1)
  })

  // A listed child whose row is still missing after the eviction refill is
  // absent, as it was before rows were checked: one refill per command. The
  // refill bumps the accessor's refill count, which used to send the retry
  // into a second refill of its own.
  it('refills once per command for a row the refill does not bring back', async () => {
    const fake = await hubOf()
    const store = new RAMIndexCacheStore()
    const w = wsOf(await vfsOf(fake), store)
    await out(w, 'ls /m')
    rowStaysMissing(store, '/m/docs/sub/b.txt')
    for (const command of [1, 2]) {
      fake.log.length = 0
      const result = await w.shell('stat /m/docs/sub/b.txt')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('No such file')
      expect(fake.count('tree'), String(command)).toBe(1)
    }
  })

  // A name the live listing does not hold is absent, and costs no refill.
  it.each(rowBackends)('answers an unlisted name absent without a refill (%s)', async (backend) => {
    const fake = await hubOf()
    const w = wsOf(await vfsOf(fake), storeOf(backend))
    await out(w, 'ls /m')
    fake.log.length = 0
    const result = await w.shell('stat /m/docs/sub/zz.txt')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toContain('No such file')
    expect(fake.count('tree')).toBe(0)
  })
})
