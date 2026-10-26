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

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskNamespaceStore } from './disk.ts'

describe('DiskNamespaceStore', () => {
  let root: string
  let store: DiskNamespaceStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mir-diskns-'))
    store = new DiskNamespaceStore(root)
  })
  afterEach(async () => {
    await store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips nodes with quoted paths, matching Python', async () => {
    await store.set('/link.txt', { target: '/m/a.txt' })
    await store.set('/sub/deep.txt', { mtime: 123 })
    const entries = await store.load()
    expect(entries.get('/link.txt')).toEqual({ target: '/m/a.txt' })
    expect(entries.get('/sub/deep.txt')).toEqual({ mtime: 123 })
    expect(readdirSync(root)).toEqual(['namespace.json'])
  })

  it('deletes and replaces all', async () => {
    await store.set('/a', { mode: 1 })
    await store.set('/b', { mode: 2 })
    await store.delete(['/a', '/missing'])
    expect([...(await store.load()).keys()]).toEqual(['/b'])
    await store.replaceAll(new Map([['/c', { mode: 3 }]]))
    expect([...(await store.load()).keys()]).toEqual(['/c'])
  })

  it('clears everything', async () => {
    await store.set('/a', { mode: 1 })
    await store.clear()
    expect((await store.load()).size).toBe(0)
  })

  it('casSet checks the record generation', async () => {
    await store.set('/legacy', { mode: 1 })
    expect(await store.casSet('/legacy', { mode: 2, generation: 1 }, 0)).toBe(true)
    expect(await store.casSet('/legacy', { mode: 3, generation: 1 }, 0)).toBe(false)
    expect(await store.casSet('/legacy', { mode: 3, generation: 2 }, 1)).toBe(true)
    expect((await store.load()).get('/legacy')).toEqual({ mode: 3, generation: 2 })
    expect(readdirSync(root)).toEqual(['namespace.json'])
  })
})
