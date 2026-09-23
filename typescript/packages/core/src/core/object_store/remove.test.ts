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
import { runWithCacheManager } from '../../cache/context.ts'
import { runWithRecording } from '../../observe/context.ts'
import { codeOf, FakeAccessor, FakeManager, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeRemovePrefix, makeRmdir, makeUnlink } from './remove.ts'

const accessor = new FakeAccessor()

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

describe('object_store remove', () => {
  it('unlink deletes and invalidates every ancestor listing', async () => {
    // Deleting the last key under a/b makes /a/b and /a disappear as
    // implied prefixes; the stale-ancestor eviction is the pinned fix.
    const store = new FakeStore({ 'a/b/c.txt': 'hi' })
    const manager = await managed(() => makeUnlink(makeDriver(store))(accessor, spec('/a/b/c.txt')))
    expect(store.contents()).toEqual({})
    expect(manager.unlinks).toEqual(['/a/b/c.txt'])
    expect(manager.writes).toEqual(['/a/b', '/a'])
  })

  it('removePrefix deletes the subtree and ancestors evict', async () => {
    const store = new FakeStore({ 'a/b/c.txt': 'hi', 'a/b/d/e.txt': 'x' })
    const manager = await managed(() => makeRemovePrefix(makeDriver(store))(accessor, spec('/a/b')))
    expect(store.contents()).toEqual({})
    // A subtree evict, not an unlink: every key below /a/b went with it,
    // and each one was cached under its own key.
    expect(manager.subtrees).toEqual(['/a/b'])
    expect(manager.unlinks).toEqual([])
    expect(manager.writes).toEqual(['/a'])
  })

  // rmdir is not removePrefix. On a keyed store an empty directory is its
  // marker object, so a prefix delete removes an empty directory correctly
  // and a non-empty one recursively -- which is `rm -r`. The two slots
  // shared one function, so every caller that does not pre-check emptiness
  // itself (FUSE, `ws.vfs`, the sandbox runtimes) destroyed the subtree.
  it('rmdir refuses a non-empty prefix and keeps every key', async () => {
    const store = new FakeStore({ 'a/b/': '', 'a/b/c.txt': 'hi', 'a/b/d/e.txt': 'x' })
    const code = await codeOf(makeRmdir(makeDriver(store))(accessor, spec('/a/b')))
    expect(code).toBe('ENOTEMPTY')
    expect(store.contents()).toEqual({ 'a/b/': '', 'a/b/c.txt': 'hi', 'a/b/d/e.txt': 'x' })
  })

  it('rmdir refuses a prefix whose only child is a subdirectory', async () => {
    const store = new FakeStore({ 'a/b/': '', 'a/b/d/': '' })
    const code = await codeOf(makeRmdir(makeDriver(store))(accessor, spec('/a/b')))
    expect(code).toBe('ENOTEMPTY')
    expect(store.contents()).toEqual({ 'a/b/': '', 'a/b/d/': '' })
  })

  it('rmdir removes the marker of an empty prefix', async () => {
    const store = new FakeStore({ 'a/b/': '', 'keep.txt': 'k' })
    const manager = await managed(() => makeRmdir(makeDriver(store))(accessor, spec('/a/b')))
    expect(store.contents()).toEqual({ 'keep.txt': 'k' })
    expect(manager.unlinks).toEqual(['/a/b'])
    expect(manager.writes).toEqual(['/a'])
  })

  it('rmdir reports ENOENT for a prefix holding no key', async () => {
    const store = new FakeStore({ 'keep.txt': 'k' })
    const code = await codeOf(makeRmdir(makeDriver(store))(accessor, spec('/a/b')))
    expect(code).toBe('ENOENT')
    expect(store.contents()).toEqual({ 'keep.txt': 'k' })
  })

  // The whole-store case, which the shared prefix delete got wrong. A mount
  // root resolves to the bare key prefix, so `makeRemovePrefix` in this slot
  // emptied the entire store. MountRootPolicy refuses a mount root as an
  // operand with EBUSY, but only on the command path; FUSE and `ws.vfs`
  // reach the op. The root is also the one path that cannot report ENOENT --
  // it exists because it is mounted -- so an empty root is a no-op.
  it('rmdir on a populated mount root destroys nothing', async () => {
    const store = new FakeStore({ 'a.txt': 'x', 'd/f.txt': 'y' })
    const code = await codeOf(makeRmdir(makeDriver(store))(accessor, spec('/')))
    expect(code).toBe('ENOTEMPTY')
    expect(store.contents()).toEqual({ 'a.txt': 'x', 'd/f.txt': 'y' })
  })

  it('rmdir on an empty mount root is a no-op', async () => {
    const store = new FakeStore({})
    await managed(() => makeRmdir(makeDriver(store))(accessor, spec('/')))
    expect(store.contents()).toEqual({})
  })

  it('rmdir leaves a child that arrived after the probe', async () => {
    // The delete is the marker, not the prefix. A concurrent writer can
    // create a child between the emptiness listing and the delete, and a
    // prefix delete would take that child down with it -- the subtree loss
    // this function exists to stop, in a smaller window. So rmdir deletes
    // only the one key that spells "empty directory", which nothing
    // arriving after the probe can widen.
    const store = new FakeStore({ 'a/b/': '' })
    const driver = makeDriver(store)
    async function* racingChildren(conn: FakeStore, pfx: string) {
      yield* driver.listChildren(conn, pfx)
      conn.objects.set('a/b/late.txt', new TextEncoder().encode('new'))
    }
    const rmdir = makeRmdir({ ...driver, listChildren: racingChildren })
    await managed(() => rmdir(accessor, spec('/a/b')))
    expect(store.contents()).toEqual({ 'a/b/late.txt': 'new' })
    expect(store.deletes).toEqual(['a/b/'])
  })
})

async function recorded(fn: () => Promise<void>): Promise<[string, string][]> {
  const [, records] = await runWithRecording(async () => {
    await managed(fn)
  })
  return records.map((r) => [r.op, r.path])
}

describe('object_store remove retraction records', () => {
  it('unlink records a retraction', async () => {
    const store = new FakeStore()
    store.objects.set('a/b.txt', new Uint8Array(1))
    const records = await recorded(() => makeUnlink(makeDriver(store))(accessor, spec('/a/b.txt')))
    expect(records).toEqual([['unlink', '/mnt/a/b.txt']])
  })

  it('removePrefix records a retraction', async () => {
    const store = new FakeStore()
    store.objects.set('a/b.txt', new Uint8Array(1))
    const records = await recorded(() => makeRemovePrefix(makeDriver(store))(accessor, spec('/a')))
    expect(records).toEqual([['rm_r', '/mnt/a']])
  })

  it('rmdir records a retraction when it deletes the marker', async () => {
    const store = new FakeStore()
    store.objects.set('a/', new Uint8Array(0))
    const records = await recorded(() => makeRmdir(makeDriver(store))(accessor, spec('/a')))
    expect(records).toEqual([['rmdir', '/mnt/a']])
  })

  it('rmdir on a keyless root records nothing', async () => {
    // It deletes nothing and throws nothing, so a record there would
    // retract a pin for an object no one touched.
    const records = await recorded(() =>
      makeRmdir(makeDriver(new FakeStore()))(accessor, spec('/')),
    )
    expect(records).toEqual([])
  })
})

describe('a retraction records even when the driver call throws', () => {
  it('unlink records regardless, so the pin cannot outlive the object', async () => {
    // A delete that fails part-way has already removed keys; an
    // over-drop costs a refetch, a surviving pin fails the next load.
    const driver = {
      ...makeDriver(new FakeStore()),
      deleteFile: () => Promise.reject(new Error('store on fire')),
    }
    const [, records] = await runWithRecording(async () => {
      await expect(managed(() => makeUnlink(driver)(accessor, spec('/a/b.txt')))).rejects.toThrow(
        'store on fire',
      )
    })
    expect(records.map((r) => [r.op, r.path])).toEqual([['unlink', '/mnt/a/b.txt']])
  })
})

describe('a retraction evicts the cache even when the driver call throws', () => {
  it('unlink evicts the body and the ancestor listings', async () => {
    // The eviction rides with the record: with the pin gone, a cached
    // body left behind would be served by a restored snapshot with
    // nothing left to check it.
    const driver = {
      ...makeDriver(new FakeStore()),
      deleteFile: () => Promise.reject(new Error('store on fire')),
    }
    const manager = await managed(async () => {
      await expect(makeUnlink(driver)(accessor, spec('/a/b.txt'))).rejects.toThrow('store on fire')
    })
    expect(manager.unlinks).toEqual(['/a/b.txt'])
    expect(manager.writes).toEqual(['/a'])
  })

  it('removePrefix evicts the subtree', async () => {
    const driver = {
      ...makeDriver(new FakeStore()),
      deletePrefix: () => Promise.reject(new Error('store on fire')),
    }
    const manager = await managed(async () => {
      await expect(makeRemovePrefix(driver)(accessor, spec('/a/b'))).rejects.toThrow(
        'store on fire',
      )
    })
    expect(manager.subtrees).toEqual(['/a/b'])
    expect(manager.writes).toEqual(['/a'])
  })
})
