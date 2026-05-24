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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalBackend } from './backend.ts'
import { HeadMovedError } from './errors.ts'
import { VersionStore } from './store.ts'

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe('VersionStore', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mir-ver-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes and reads a blob', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    const oid = await store.writeBlob(enc('hello'))
    expect(await store.readBlob(oid)).toEqual(enc('hello'))
  })

  it('dedups identical blobs to one oid', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    expect(await store.writeBlob(enc('x'))).toBe(await store.writeBlob(enc('x')))
  })

  it('commits, advances branch, links parent, logs newest-first', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    const t1 = await store.writeTree({ 'a.txt': await store.writeBlob(enc('one')) })
    const c1 = await store.commit(t1, [], 'main', 'first')
    const t2 = await store.writeTree({ 'a.txt': await store.writeBlob(enc('two')) })
    const c2 = await store.commit(t2, [c1], 'main', 'second')
    expect(await store.head('main')).toBe(c2)
    expect((await store.readCommit(c2)).parents).toEqual([c1])
    expect(await store.log('main')).toEqual([c2, c1])
  })

  it('round-trips a nested tree through readTree', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    const tree = await store.writeTree({
      'a.txt': await store.writeBlob(enc('A')),
      'd/b.txt': await store.writeBlob(enc('B')),
    })
    expect(Object.keys(await store.readTree(tree)).sort()).toEqual(['a.txt', 'd/b.txt'])
  })

  it('diff reports added / modified / deleted', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    const a = await store.writeTree({
      'a.txt': await store.writeBlob(enc('one')),
      'gone.txt': await store.writeBlob(enc('g')),
    })
    const b = await store.writeTree({
      'a.txt': await store.writeBlob(enc('two')),
      'new.txt': await store.writeBlob(enc('n')),
    })
    expect(await store.diff(a, b)).toEqual({
      added: ['new.txt'],
      modified: ['a.txt'],
      deleted: ['gone.txt'],
    })
  })

  it('rejects a commit against a stale head (CAS)', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    const t1 = await store.writeTree({ 'a.txt': await store.writeBlob(enc('one')) })
    const c1 = await store.commit(t1, [], 'main', 'first')
    const t2 = await store.writeTree({ 'a.txt': await store.writeBlob(enc('two')) })
    await store.commit(t2, [c1], 'main', 'second')
    const t3 = await store.writeTree({ 'a.txt': await store.writeBlob(enc('three')) })
    await expect(store.commit(t3, [c1], 'main', 'stale')).rejects.toThrow(HeadMovedError)
  })

  it('lists and isolates branches', async () => {
    const store = await VersionStore.open(new LocalBackend(root), 'ws')
    const t1 = await store.writeTree({ 'a.txt': await store.writeBlob(enc('one')) })
    const c1 = await store.commit(t1, [], 'main', 'first')
    await store.setBranch('exp', c1)
    expect((await store.branches()).sort()).toEqual(['exp', 'main'])
    expect(await store.head('exp')).toBe(c1)
  })
})
