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
import { makeExists } from './exists.ts'
import { codeOf, FakeAccessor, FakeManager, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeRename } from './rename.ts'
import { makeStat } from './stat.ts'

const accessor = new FakeAccessor()

function renameFor(store: FakeStore) {
  const driver = makeDriver(store)
  return makeRename(driver, makeExists(makeStat(driver)))
}

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

describe('object_store rename', () => {
  it('moves a file', async () => {
    const store = new FakeStore({ 'a/src.txt': 'hi' })
    const manager = await managed(() =>
      renameFor(store)(accessor, spec('/a/src.txt'), spec('/b/dst.txt')),
    )
    expect(store.contents()).toEqual({ 'b/dst.txt': 'hi' })
    expect(manager.subtrees).toEqual(['/b/dst.txt', '/a/src.txt'])
    expect(manager.writes).toEqual(['/b', '/a'])
  })

  it('falls back to the prefix walk', async () => {
    const store = new FakeStore({ 'dir/f.txt': 'x', 'dir/sub/g.txt': 'y' })
    await managed(() => renameFor(store)(accessor, spec('/dir'), spec('/moved')))
    expect(store.contents()).toEqual({ 'moved/f.txt': 'x', 'moved/sub/g.txt': 'y' })
  })

  it('a missing source is ENOENT', async () => {
    const store = new FakeStore()
    await expect(
      codeOf(managed(() => renameFor(store)(accessor, spec('/never'), spec('/dst')))),
    ).resolves.toBe('ENOENT')
  })

  it('renaming onto the same key is a guarded no-op', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const manager = await managed(() => renameFor(store)(accessor, spec('/a.txt'), spec('/a.txt')))
    expect(store.contents()).toEqual({ 'a.txt': 'hi' })
    expect(manager.unlinks).toEqual([])
    expect(manager.subtrees).toEqual([])
  })

  it('renaming onto the same key still fails when absent', async () => {
    await expect(
      codeOf(managed(() => renameFor(new FakeStore())(accessor, spec('/a.txt'), spec('/a.txt')))),
    ).resolves.toBe('ENOENT')
  })

  it('refuses to build without a native move', () => {
    const driver = makeDriver(new FakeStore())
    delete driver.moveFile
    delete driver.movePrefix
    expect(() => makeRename(driver, makeExists(makeStat(driver)))).toThrow('no native move')
  })
})

async function recorded(fn: () => Promise<void>): Promise<[string, string][]> {
  const [, records] = await runWithRecording(async () => {
    await managed(fn)
  })
  return records.map((r) => [r.op, r.path])
}

function alwaysExists(): Promise<boolean> {
  return Promise.resolve(true)
}

describe('object_store rename retraction records', () => {
  it('records a retraction for both paths', async () => {
    // A move invalidates the token of both: src's object left, dst's was
    // replaced by it.
    const store = new FakeStore()
    store.objects.set('a.txt', new Uint8Array(1))
    const records = await recorded(() =>
      makeRename(makeDriver(store), alwaysExists)(accessor, spec('/a.txt'), spec('/b.txt')),
    )
    expect(records).toEqual([
      ['rename', '/mnt/a.txt'],
      ['rename', '/mnt/b.txt'],
    ])
  })

  it('a self-rename records nothing', async () => {
    const store = new FakeStore()
    store.objects.set('a.txt', new Uint8Array(1))
    const records = await recorded(() =>
      makeRename(makeDriver(store), alwaysExists)(accessor, spec('/a.txt'), spec('/a.txt')),
    )
    expect(records).toEqual([])
  })

  it('records both retractions when the prefix walk fails', async () => {
    // moveFile's clean false is the ordinary way into the prefix walk,
    // not an answer about it. The walk is paginated and can reject
    // having already moved keys, which is the case the record is in
    // `finally` for.
    const store = new FakeStore()
    store.objects.set('d/f.txt', new Uint8Array(1))
    const driver = makeDriver(store)
    driver.movePrefix = () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' }))
    const { code, records } = await recordedFailure(() =>
      makeRename(driver, alwaysExists)(accessor, spec('/d'), spec('/e')),
    )
    expect(code).toBe('EIO')
    expect(records).toEqual([
      ['rename_prefix', '/mnt/d'],
      ['rename_prefix', '/mnt/e'],
    ])
  })

  it('evicts both subtrees when the prefix walk rejects', async () => {
    // The eviction rides with the records, on the same condition.
    const store = new FakeStore()
    store.objects.set('d/f.txt', new Uint8Array(1))
    const driver = makeDriver(store)
    driver.movePrefix = () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' }))
    const manager = await managed(async () => {
      expect(await codeOf(makeRename(driver, alwaysExists)(accessor, spec('/d'), spec('/e')))).toBe(
        'EIO',
      )
    })
    expect(manager.subtrees).toEqual(['/e', '/d'])
  })

  it('records nothing when the source is missing', async () => {
    // Both calls answering a clean false is the store saying nothing
    // moved at all, which is the one outcome safe to skip.
    const { code, records } = await recordedFailure(() =>
      makeRename(makeDriver(new FakeStore()), alwaysExists)(
        accessor,
        spec('/a.txt'),
        spec('/b.txt'),
      ),
    )
    expect(code).toBe('ENOENT')
    expect(records).toEqual([])
  })
})

async function recordedFailure(
  fn: () => Promise<void>,
): Promise<{ code: string; records: [string, string][] }> {
  let code = 'no-throw'
  const [, records] = await runWithRecording(async () => {
    code = await codeOf(managed(fn))
  })
  return { code, records: records.map((r) => [r.op, r.path]) }
}
