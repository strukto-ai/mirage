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
import { makeCopy } from './copy.ts'
import { makeExists } from './exists.ts'
import { codeOf, FakeAccessor, FakeManager, FakeStore, makeDriver, spec } from './fakes.ts'
import { makeStat } from './stat.ts'

const accessor = new FakeAccessor()

function copyFor(store: FakeStore) {
  const driver = makeDriver(store)
  return makeCopy(driver, makeExists(makeStat(driver)))
}

async function managed(fn: () => Promise<void>): Promise<FakeManager> {
  const manager = new FakeManager()
  await runWithCacheManager(manager, fn)
  return manager
}

describe('object_store copy', () => {
  it('duplicates and invalidates destination ancestors', async () => {
    const store = new FakeStore({ 'src.txt': 'hi' })
    const manager = await managed(() =>
      copyFor(store)(accessor, spec('/src.txt'), spec('/a/b/dst.txt')),
    )
    expect(store.contents()).toEqual({ 'src.txt': 'hi', 'a/b/dst.txt': 'hi' })
    expect(manager.writes).toEqual(['/a/b/dst.txt', '/a/b', '/a'])
  })

  it('a missing source is ENOENT', async () => {
    await expect(
      codeOf(managed(() => copyFor(new FakeStore())(accessor, spec('/never'), spec('/dst.txt')))),
    ).resolves.toBe('ENOENT')
  })

  it('copying onto the same key is a guarded no-op', async () => {
    const store = new FakeStore({ 'a.txt': 'hi' })
    const manager = await managed(() => copyFor(store)(accessor, spec('/a.txt'), spec('/a.txt')))
    expect(store.contents()).toEqual({ 'a.txt': 'hi' })
    expect(manager.writes).toEqual([])
  })

  it('copying onto the same key still fails when absent', async () => {
    await expect(
      codeOf(managed(() => copyFor(new FakeStore())(accessor, spec('/a.txt'), spec('/a.txt')))),
    ).resolves.toBe('ENOENT')
  })

  it('refuses to build without a native copy', () => {
    const driver = makeDriver(new FakeStore())
    delete driver.copyFile
    expect(() => makeCopy(driver, makeExists(makeStat(driver)))).toThrow('no native copy')
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

describe('object_store copy retraction record', () => {
  it('records a retraction for the destination', async () => {
    // A copy replaces dst's bytes and leaves src untouched, so only
    // dst's token stops describing its object.
    const store = new FakeStore()
    store.objects.set('a.txt', new Uint8Array(1))
    const records = await recorded(() =>
      makeCopy(makeDriver(store), alwaysExists)(accessor, spec('/a.txt'), spec('/b.txt')),
    )
    expect(records).toEqual([['copy', '/mnt/b.txt']])
  })

  it('a self-copy records nothing', async () => {
    const store = new FakeStore()
    store.objects.set('a.txt', new Uint8Array(1))
    const records = await recorded(() =>
      makeCopy(makeDriver(store), alwaysExists)(accessor, spec('/a.txt'), spec('/a.txt')),
    )
    expect(records).toEqual([])
  })

  it('records the retraction when the store throws', async () => {
    // A rejection may have left a partial object on dst, so its token
    // stops describing what is there.
    const store = new FakeStore()
    store.objects.set('a.txt', new Uint8Array(1))
    const driver = makeDriver(store)
    driver.copyFile = () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' }))
    const { code, records } = await recordedFailure(() =>
      makeCopy(driver, alwaysExists)(accessor, spec('/a.txt'), spec('/b.txt')),
    )
    expect(code).toBe('EIO')
    expect(records).toEqual([['copy', '/mnt/b.txt']])
  })

  it('evicts the destination when the store throws', async () => {
    // The eviction rides with the record, on the same condition.
    const store = new FakeStore()
    store.objects.set('a.txt', new Uint8Array(1))
    const driver = makeDriver(store)
    driver.copyFile = () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' }))
    const manager = await managed(async () => {
      expect(
        await codeOf(makeCopy(driver, alwaysExists)(accessor, spec('/a.txt'), spec('/b.txt'))),
      ).toBe('EIO')
    })
    expect(manager.writes).toEqual(['/b.txt'])
  })

  it('records nothing when the source is missing', async () => {
    // A clean false is the store saying nothing was copied.
    const { code, records } = await recordedFailure(() =>
      makeCopy(makeDriver(new FakeStore()), alwaysExists)(accessor, spec('/a.txt'), spec('/b.txt')),
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
