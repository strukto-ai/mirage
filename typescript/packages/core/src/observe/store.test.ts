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
import { RAMObserverStore } from './store.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function decode(files: Map<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of files) out[k] = DEC.decode(v)
  return out
}

describe('RAMObserverStore', () => {
  it('append creates and extends', async () => {
    const store = new RAMObserverStore()
    await store.append('/d/s.jsonl', ENC.encode('a\n'))
    await store.append('/d/s.jsonl', ENC.encode('b\n'))
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': 'a\nb\n' })
  })

  it('append copies only its own bytes, not the log so far', async () => {
    const store = new RAMObserverStore()
    const buffers = new Set<ArrayBufferLike>()
    for (let i = 0; i < 1000; i++) {
      await store.append('/d/s.jsonl', ENC.encode(`${String(i % 10)}\n`))
      buffers.add(store.files.get('/d/s.jsonl')?.buffer ?? new ArrayBuffer(0))
    }
    expect(buffers.size).toBeLessThan(20)
    const want = Array.from({ length: 1000 }, (_, i) => `${String(i % 10)}\n`).join('')
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': want })
  })

  it('append extends a file set by write or by hand', async () => {
    const store = new RAMObserverStore()
    await store.append('/d/s.jsonl', ENC.encode('a\n'))
    await store.append('/d/s.jsonl', ENC.encode('b\n'))
    await store.write('/d/s.jsonl', ENC.encode('w\n'))
    await store.append('/d/s.jsonl', ENC.encode('c\n'))
    store.files.set('/d/t.jsonl', ENC.encode('h\n'))
    await store.append('/d/t.jsonl', ENC.encode('d\n'))
    expect(decode(await store.readAll())).toEqual({
      '/d/s.jsonl': 'w\nc\n',
      '/d/t.jsonl': 'h\nd\n',
    })
  })

  it('write overwrites', async () => {
    const store = new RAMObserverStore()
    await store.append('/d/s.jsonl', ENC.encode('old\n'))
    await store.write('/d/s.jsonl', ENC.encode('new\n'))
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': 'new\n' })
  })

  it('readMatching filters by suffix', async () => {
    const store = new RAMObserverStore()
    await store.append('/d1/s1.jsonl', ENC.encode('a\n'))
    await store.append('/d1/s2.jsonl', ENC.encode('b\n'))
    await store.append('/d2/s1.jsonl', ENC.encode('c\n'))
    expect(decode(await store.readMatching('/s1.jsonl'))).toEqual({
      '/d1/s1.jsonl': 'a\n',
      '/d2/s1.jsonl': 'c\n',
    })
  })

  it('clear empties the store', async () => {
    const store = new RAMObserverStore()
    await store.append('/d/s.jsonl', ENC.encode('a\n'))
    await store.clear()
    expect((await store.readAll()).size).toBe(0)
  })
})
