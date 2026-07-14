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
import { RAMNamespaceStore } from './ram.ts'

describe('RAMNamespaceStore', () => {
  it('set/load roundtrip', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/data/f.txt', { mode: 0o601, uid: 500 })
    await store.set('/data/link', { target: '/t1', mtime: 1 })
    const entries = await store.load()
    expect(entries.get('/data/f.txt')).toEqual({ mode: 0o601, uid: 500 })
    expect(entries.get('/data/link')).toEqual({ target: '/t1', mtime: 1 })
  })

  it('set overwrites the whole entry', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/data/f.txt', { mode: 0o600, mtime: 1 })
    await store.set('/data/f.txt', { mode: 0o601 })
    expect((await store.load()).get('/data/f.txt')).toEqual({ mode: 0o601 })
  })

  it('delete drops a batch, tolerating missing keys', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/a', { mode: 1 })
    await store.set('/b', { mode: 2 })
    await store.set('/c', { mode: 3 })
    await store.delete(['/a', '/c', '/missing'])
    expect([...(await store.load()).keys()]).toEqual(['/b'])
  })

  it('replaceAll overwrites the table', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/old', { mode: 1 })
    await store.replaceAll(new Map([['/new', { mode: 2 }]]))
    expect((await store.load()).get('/old')).toBeUndefined()
    expect((await store.load()).get('/new')).toEqual({ mode: 2 })
    await store.replaceAll(new Map())
    expect((await store.load()).size).toBe(0)
  })

  it('clear empties the table', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/a', { mode: 1 })
    await store.clear()
    expect((await store.load()).size).toBe(0)
    await store.close()
  })

  it('load returns copies', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/a', { mode: 1 })
    const entries = await store.load()
    const entry = entries.get('/a')
    if (entry === undefined) throw new Error('missing entry')
    entry.mode = 999
    expect((await store.load()).get('/a')).toEqual({ mode: 1 })
  })

  it('user roundtrip', async () => {
    const store = new RAMNamespaceStore()
    expect(await store.loadUser()).toBeNull()
    await store.setUser('alice')
    expect(await store.loadUser()).toBe('alice')
  })

  it('user survives replaceAll but not clear', async () => {
    const store = new RAMNamespaceStore()
    await store.setUser('alice')
    await store.replaceAll(new Map([['/a', { mode: 1 }]]))
    expect(await store.loadUser()).toBe('alice')
    await store.clear()
    expect(await store.loadUser()).toBeNull()
  })
})
