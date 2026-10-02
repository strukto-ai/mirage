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
import type { OpRecord } from '../../observe/record.ts'
import { errorVirtualPath } from '../../utils/errors.ts'
import type { ObjectStoreDriver } from './driver.ts'
import type { FakeStore as Store } from './fakes.ts'
import { FakeAccessor, FakeManager, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeCreate, makeMkdir, makeTruncate, makeWriteBytes } from './write.ts'

const accessor = new FakeAccessor()
const ENC = new TextEncoder()

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

class MissingContainer extends Error {}

// A driver whose put fails the way a missing repository or bucket does.
function missingContainer(): ObjectStoreDriver<FakeAccessor, Store> {
  return {
    ...makeDriver(new FakeStore()),
    put: () => Promise.reject(new MissingContainer('gone')),
    isNotFound: (err: unknown) => err instanceof MissingContainer,
  }
}

async function caught(fn: () => Promise<void>): Promise<unknown> {
  try {
    await managed(fn)
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('object_store write', () => {
  it('write puts and invalidates every ancestor listing', async () => {
    const store = new FakeStore()
    const manager = await managed(() =>
      makeWriteBytes(makeDriver(store))(accessor, spec('/a/b/c.txt'), ENC.encode('hi')),
    )
    expect(store.contents()).toEqual({ 'a/b/c.txt': 'hi' })
    expect(manager.settled.map((w) => w.path)).toEqual(['/mnt/a/b/c.txt'])
    expect(manager.writes).toEqual([])
    expect(manager.ancestors).toEqual(['/mnt/a/b/c.txt'])
  })

  it('write at the mount root invalidates only itself', async () => {
    const store = new FakeStore()
    const manager = await managed(() =>
      makeWriteBytes(makeDriver(store))(accessor, spec('/c.txt'), ENC.encode('x')),
    )
    expect(manager.settled.map((w) => w.path)).toEqual(['/mnt/c.txt'])
    expect(manager.writes).toEqual([])
  })

  it('create puts empty and invalidates ancestors', async () => {
    const store = new FakeStore()
    const manager = await managed(() => makeCreate(makeDriver(store))(accessor, spec('/a/b/c.txt')))
    expect(store.contents()).toEqual({ 'a/b/c.txt': '' })
    expect(manager.writes).toEqual(['/a/b/c.txt'])
    expect(manager.ancestors).toEqual(['/mnt/a/b/c.txt'])
  })

  it('truncate pads with NUL and invalidates ancestors', async () => {
    const store = new FakeStore({ 'a/f.bin': '0123456789' })
    const manager = await managed(() =>
      makeTruncate(makeDriver(store))(accessor, spec('/a/f.bin'), 4),
    )
    expect(store.text('a/f.bin')).toBe('0123')
    expect(manager.writes).toEqual(['/a/f.bin'])
    expect(manager.ancestors).toEqual(['/mnt/a/f.bin'])
  })

  it('truncate extends a missing key', async () => {
    const store = new FakeStore()
    await managed(() => makeTruncate(makeDriver(store))(accessor, spec('/f.bin'), 3))
    expect(store.text('f.bin')).toBe('\0\0\0')
  })

  it('mkdir writes a marker and parents gate ancestors', async () => {
    const store = new FakeStore({ 'a/': '' })
    const manager = await managed(() => makeMkdir(makeDriver(store))(accessor, spec('/a/b')))
    expect(store.contents()).toEqual({ 'a/': '', 'a/b/': '' })
    expect(manager.writes).toEqual(['/a/b'])
    const deep = await managed(() => makeMkdir(makeDriver(store))(accessor, spec('/x/y'), true))
    expect(deep.writes).toEqual(['/x/y'])
    expect(deep.ancestors).toEqual(['/mnt/x/y'])
  })

  it('write names the path, not the key, when the container is gone', async () => {
    // The driver primitives speak keys, so the store's own error names
    // "a/b/c.txt"; only the factory can restate it as the path the user
    // typed, which is the only spelling allowed in a message.
    const driver = missingContainer()
    const err = await caught(() =>
      makeWriteBytes(driver)(accessor, spec('/a/b/c.txt'), ENC.encode('hi')),
    )
    expect((err as { code?: string }).code).toBe('ENOENT')
    expect(errorVirtualPath(err)).toBe('/mnt/a/b/c.txt')
  })

  it('create and truncate name the path too', async () => {
    const created = await caught(() => makeCreate(missingContainer())(accessor, spec('/a/new.txt')))
    expect(errorVirtualPath(created)).toBe('/mnt/a/new.txt')
    const cut = await caught(() =>
      makeTruncate(missingContainer())(accessor, spec('/a/cut.txt'), 4),
    )
    expect(errorVirtualPath(cut)).toBe('/mnt/a/cut.txt')
  })

  it('a store error that is not a missing container propagates', async () => {
    const driver = {
      ...makeDriver(new FakeStore()),
      put: () => Promise.reject(new Error('bucket on fire')),
    }
    const err = await caught(() =>
      makeWriteBytes(driver)(accessor, spec('/a.txt'), ENC.encode('hi')),
    )
    expect((err as Error).message).toBe('bucket on fire')
    expect((err as { code?: string }).code).toBeUndefined()
  })

  it('mkdir refuses a name that exists', async () => {
    // mkdir(2) answers EEXIST for a directory or a file already there,
    // and `mkdir -p` passes only the directory. Rewriting the marker
    // answered success to every caller that skips the command builder's
    // own check: a guest, FUSE, ws.vfs.
    const store = new FakeStore({ 'a/b/': '', 'f.txt': 'x' })
    const mkdir = makeMkdir(makeDriver(store))
    for (const [path, parents] of [
      ['/a/b', false],
      ['/f.txt', false],
      ['/f.txt', true],
    ] as const) {
      await expect(managed(() => mkdir(accessor, spec(path), parents))).rejects.toMatchObject({
        code: 'EEXIST',
      })
    }
    expect(store.puts).toEqual([])
  })

  it('mkdir refuses a missing parent without parents', async () => {
    // mkdir(2) makes one directory under one that exists; only `-p` makes
    // the chain, so a guest's os.mkdir under a missing parent is ENOENT
    // and puts nothing.
    const store = new FakeStore()
    const err = await caught(() => makeMkdir(makeDriver(store))(accessor, spec('/a/b')))
    expect((err as { code?: string }).code).toBe('ENOENT')
    expect(store.puts).toEqual([])
  })

  it('mkdir refuses a directory under a file', async () => {
    // A marker below a file put a directory under it. mkdir(2) blames the
    // operand; the walk `mkdir -p` makes names the file it stops at.
    const store = new FakeStore({ 'f.txt': 'x' })
    const mkdir = makeMkdir(makeDriver(store))
    for (const [path, parents, named] of [
      ['/f.txt/sub', false, '/mnt/f.txt/sub'],
      ['/f.txt/x/y', true, '/mnt/f.txt'],
    ] as const) {
      await expect(managed(() => mkdir(accessor, spec(path), parents))).rejects.toMatchObject({
        code: 'ENOTDIR',
        message: named,
      })
    }
    expect(store.puts).toEqual([])
  })

  // Without markers a parent made a moment ago has no row, so even a
  // plain mkdir under it cannot be checked and stays a no-op.
  it.each([true, false])(
    'mkdir without marker support is a no-op (parents %s)',
    async (parents) => {
      const store = new FakeStore()
      const driver = { ...makeDriver(store), markersSupported: false }
      const manager = await managed(() => makeMkdir(driver)(accessor, spec('/a/b'), parents))
      expect(store.contents()).toEqual({})
      expect(manager.writes).toEqual([])
    },
  )
})

// ── the backend token the put answered reaches the op record ───────────

async function recorded(fn: () => Promise<void>): Promise<OpRecord[]> {
  const [, records] = await runWithRecording(async () => {
    await managed(fn)
  })
  return records
}

describe('object store write records the put token', () => {
  it('write carries the token the put returned', async () => {
    const store = new FakeStore()
    const records = await recorded(() =>
      makeWriteBytes(makeDriver(store))(accessor, spec('/a/b/c.txt'), ENC.encode('hi')),
    )
    expect(records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([
      ['write', '/mnt/a/b/c.txt', 'fp-a/b/c.txt'],
    ])
  })

  it('create carries the token the put returned', async () => {
    const store = new FakeStore()
    const records = await recorded(() =>
      makeCreate(makeDriver(store))(accessor, spec('/a/new.txt')),
    )
    expect(records.map((r) => [r.op, r.fingerprint])).toEqual([['create', 'fp-a/new.txt']])
  })

  it('truncate carries the token the put returned', async () => {
    const store = new FakeStore()
    store.objects.set('a/cut.txt', ENC.encode('hello'))
    const records = await recorded(() =>
      makeTruncate(makeDriver(store))(accessor, spec('/a/cut.txt'), 2),
    )
    expect(records.map((r) => [r.op, r.fingerprint])).toEqual([['truncate', 'fp-a/cut.txt']])
  })

  it('records no token when the store reports none', async () => {
    // hf's opendal write reports nothing, so its driver answers null and
    // the record carries the same absence it does today.
    const driver: ObjectStoreDriver<FakeAccessor, Store> = {
      ...makeDriver(new FakeStore()),
      put: () => Promise.resolve(null),
    }
    const records = await recorded(() =>
      makeWriteBytes(driver)(accessor, spec('/a/c.txt'), ENC.encode('hi')),
    )
    expect(records.map((r) => r.fingerprint)).toEqual([null])
  })

  it('mkdir records nothing', async () => {
    const store = new FakeStore()
    const records = await recorded(() => makeMkdir(makeDriver(store))(accessor, spec('/a/b'), true))
    expect(records).toEqual([])
  })
})

describe('object_store write settles with the token its put answered', () => {
  it('carries the token and no size', async () => {
    // The size a put reports is the request's length, not one the store
    // read back, so the receipt carries the token alone.
    const store = new FakeStore()
    const manager = await managed(() =>
      makeWriteBytes(makeDriver(store))(accessor, spec('/a/b/c.txt'), ENC.encode('hi')),
    )
    expect(manager.settled).toEqual([
      {
        path: '/mnt/a/b/c.txt',
        data: 'hi',
        receipt: { storedSize: null, token: 'fp-a/b/c.txt' },
        generation: 5,
      },
    ])
  })

  it('a put that answers nothing settles a silent receipt', async () => {
    const driver: ObjectStoreDriver<FakeAccessor, Store> = {
      ...makeDriver(new FakeStore()),
      put: () => Promise.resolve(null),
    }
    const manager = await managed(() =>
      makeWriteBytes(driver)(accessor, spec('/a/b/c.txt'), ENC.encode('hi')),
    )
    expect(manager.settled).toEqual([
      {
        path: '/mnt/a/b/c.txt',
        data: 'hi',
        receipt: { storedSize: null, token: null },
        generation: 5,
      },
    ])
  })

  it('create still only invalidates', async () => {
    const manager = await managed(() =>
      makeCreate(makeDriver(new FakeStore()))(accessor, spec('/a/c.txt')),
    )
    expect(manager.settled).toEqual([])
    expect(manager.writes).toEqual(['/a/c.txt'])
  })
})

describe('object_store write notes the generation before its put', () => {
  it('a change during the put reaches settle', async () => {
    // The generation is noted before the put, so a change of the mount that
    // lands while the put runs makes settle drop the bytes.
    const manager = new FakeManager()
    const base = makeDriver(new FakeStore())
    const driver: ObjectStoreDriver<FakeAccessor, Store> = {
      ...base,
      put: (conn, key, data) => {
        manager.generation = 6
        return base.put(conn, key, data)
      },
    }
    await runWithCacheManager(manager, () =>
      makeWriteBytes(driver)(accessor, spec('/a/c.txt'), ENC.encode('hi')),
    )
    expect(manager.settled.map((w) => w.generation)).toEqual([5])
  })
})
