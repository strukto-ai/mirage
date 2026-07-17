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
import { RAMSessionStore } from './ram.ts'

describe('RAMSessionStore', () => {
  it('set/load round-trips', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/a', env: {} })
    await store.set('s2', {
      session_id: 's2',
      cwd: '/',
      env: { K: 'v' },
      mount_modes: { '/data': 'read' },
    })
    const entries = await store.load()
    expect(entries.get('s1')?.cwd).toBe('/a')
    expect(entries.get('s2')?.mount_modes).toEqual({ '/data': 'read' })
  })

  it('load returns copies', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/' })
    const entries = await store.load()
    const s1 = entries.get('s1')
    if (s1 === undefined) throw new Error('missing s1')
    s1.cwd = '/mutated'
    const again = await store.load()
    expect(again.get('s1')?.cwd).toBe('/')
  })

  it('delete and replaceAll', async () => {
    const store = new RAMSessionStore()
    await store.set('a', { session_id: 'a' })
    await store.set('b', { session_id: 'b' })
    await store.delete(['a', 'missing'])
    expect([...(await store.load()).keys()]).toEqual(['b'])
    await store.replaceAll(new Map([['c', { session_id: 'c' }]]))
    expect([...(await store.load()).keys()]).toEqual(['c'])
  })

  it('clear drops everything', async () => {
    const store = new RAMSessionStore()
    await store.set('a', { session_id: 'a' })
    await store.clear()
    expect((await store.load()).size).toBe(0)
    await store.close()
  })
})

describe('RAMSessionStore casSet', () => {
  it('writes on a matching generation', async () => {
    const store = new RAMSessionStore()
    const fields = { session_id: 's1', cwd: '/', env: {}, generation: 1 }
    expect(await store.casSet('s1', fields, 0)).toBe(true)
    expect((await store.load()).get('s1')?.generation).toBe(1)
  })

  it('conflicts on a stale generation', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/', generation: 2 })
    expect(await store.casSet('s1', { session_id: 's1', cwd: '/stale', generation: 1 }, 0)).toBe(
      false,
    )
    expect((await store.load()).get('s1')?.cwd).toBe('/')
  })

  it('treats a legacy record without the field as generation 0', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/old' })
    expect(await store.casSet('s1', { session_id: 's1', cwd: '/new', generation: 1 }, 0)).toBe(true)
    expect((await store.load()).get('s1')?.cwd).toBe('/new')
  })
})
