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
import { Channel } from '../console/index.ts'
import type { RecordFields } from '../../workspace/record/types.ts'
import { RAMJobStore } from './ram.ts'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

function list(names: string[], generation = 1): RecordFields {
  return {
    next: names.length + 1,
    jobs: Object.fromEntries(names.map((name, i) => [String(i + 1), { console: name }])),
    generation,
  }
}

describe('RAMJobStore', () => {
  it('writes a list under its generation', async () => {
    const store = new RAMJobStore()
    expect(await store.load('s')).toBeNull()
    expect(await store.casSet('s', list(['a']), 0)).toBe(true)
    expect(await store.casSet('s', list(['a', 'b']), 0)).toBe(false)
    expect(await store.casSet('s', list(['a', 'b'], 2), 1)).toBe(true)
    expect(Object.keys((await store.load('s'))?.jobs ?? {})).toEqual(['1', '2'])
  })

  it('hands out a copy of a loaded list', async () => {
    const store = new RAMJobStore()
    await store.casSet('s', list(['a']), 0)
    const loaded = (await store.load('s'))?.jobs as Record<string, { console: string }>
    for (const job of Object.values(loaded)) job.console = 'changed'
    const stored = (await store.load('s'))?.jobs as Record<string, { console: string }>
    expect(Object.values(stored).map((job) => job.console)).toEqual(['a'])
  })

  it('drops a console once no list names it', async () => {
    const store = new RAMJobStore()
    await store.casSet('s', list(['a']), 0)
    const held = store.console('a')
    await held.append(Channel.STDOUT, enc('kept'))
    expect(store.console('a')).toBe(held)
    await store.casSet('s', list([], 2), 1)
    expect(store.console('a')).not.toBe(held)
    const [chunks] = await held.readFrom(0)
    expect(chunks.map((c) => dec(c.data))).toEqual(['kept'])
  })

  it('never lapses an owner without a lease', async () => {
    expect(await new RAMJobStore().alive('never-renewed')).toBe(true)
  })

  it('keeps an owner alive while its lease holds', async () => {
    const store = new RAMJobStore(0.05)
    expect(await store.alive('o')).toBe(false)
    await store.renew('o')
    expect(await store.alive('o')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await store.alive('o')).toBe(false)
  })
})
