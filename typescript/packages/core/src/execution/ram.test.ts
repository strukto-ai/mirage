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
import { Channel } from '../shell/console/index.ts'
import type { RecordFields } from '../workspace/record/types.ts'
import { RAMExecutionStore } from './ram.ts'

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

function list(names: string[], generation = 1): RecordFields {
  return {
    next: names.length + 1,
    jobs: Object.fromEntries(names.map((name, i) => [String(i + 1), { console: name }])),
    generation,
  }
}

describe('RAMExecutionStore', () => {
  it('writes a list under its generation', async () => {
    const store = new RAMExecutionStore()
    expect(await store.load('s')).toBeNull()
    expect(await store.casSet('s', list(['a']), 0)).toBe(true)
    expect(await store.casSet('s', list(['a', 'b']), 0)).toBe(false)
    expect(await store.casSet('s', list(['a', 'b'], 2), 1)).toBe(true)
    expect(Object.keys((await store.load('s'))?.jobs ?? {})).toEqual(['1', '2'])
    expect(await store.delete('s', 1)).toBe(false)
    expect(await store.load('s')).not.toBeNull()
    expect(await store.delete('s', 2)).toBe(true)
    expect(await store.load('s')).toBeNull()
  })

  it('hands out a copy of a loaded list', async () => {
    const store = new RAMExecutionStore()
    await store.casSet('s', list(['a']), 0)
    const loaded = (await store.load('s'))?.jobs as Record<string, { console: string }>
    for (const job of Object.values(loaded)) job.console = 'changed'
    const stored = (await store.load('s'))?.jobs as Record<string, { console: string }>
    expect(Object.values(stored).map((job) => job.console)).toEqual(['a'])
  })

  it('drops a console once no list names it', async () => {
    const store = new RAMExecutionStore()
    await store.casSet('s', list(['a']), 0)
    const held = store.console('a')
    await held.append(Channel.STDOUT, enc('kept'))
    expect(store.console('a')).toBe(held)
    await store.casSet('s', list([], 2), 1)
    expect(store.console('a')).not.toBe(held)
    const [chunks] = await held.readFrom(0)
    expect(chunks.map((c) => dec(c.data))).toEqual(['kept'])
  })

  it("publishes a daemon's processes and drops them", async () => {
    const store = new RAMExecutionStore()
    const record = { pid: 2, command: 'sleep 30', runs: [] }
    await store.publish('a', { '2': record }, 2)
    await store.publish('b', { '5': { pid: 5, runs: [] } }, 5)
    const found = await store.processes()
    expect(found).toEqual({ a: { '2': record }, b: { '5': { pid: 5, runs: [] } } })
    ;(found.a?.['2'] as { pid: number }).pid = 9
    expect((await store.processes()).a?.['2']?.pid).toBe(2)
    await store.publish('a', {})
    expect(Object.keys(await store.processes())).toEqual(['b'])
  })

  it('takes the stops asked of a daemon once', async () => {
    const store = new RAMExecutionStore()
    await store.requestStop('a', 2, 15)
    await store.requestStop('a', 3, 9)
    await store.requestStop('b', 4, 9)
    expect(await store.takeStops('a')).toEqual([
      [2, 15],
      [3, 9],
    ])
    expect(await store.takeStops('a')).toEqual([])
    expect(await store.takeStops('b')).toEqual([[4, 9]])
  })

  it('lets one daemon hold the lease until it releases it', async () => {
    const store = new RAMExecutionStore()
    expect(await store.holder()).toBeNull()
    expect(await store.lease('a')).toBeNull()
    expect(await store.lease('a')).toBeNull()
    expect(await store.lease('b')).toBe('a')
    expect(await store.holder()).toBe('a')
    await store.release('b')
    expect(await store.holder()).toBe('a')
    await store.release('a')
    expect(await store.lease('b')).toBeNull()
    expect(await store.holder()).toBe('b')
  })

  it('lapses a lease unless renewed', async () => {
    const store = new RAMExecutionStore(0.05)
    expect(await store.lease('a')).toBeNull()
    expect(await store.lease('b')).toBe('a')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await store.holder()).toBeNull()
    expect(await store.lease('b')).toBeNull()
  })

  it('only raises the highest pid', async () => {
    const store = new RAMExecutionStore()
    expect(await store.highestPid()).toBe(0)
    await store.publish('a', {}, 7)
    await store.publish('b', {}, 3)
    expect(await store.highestPid()).toBe(7)
  })
})
