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

import { randomUUID } from 'node:crypto'
import { Observer } from '@struktoai/mirage-core/observe/observer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RedisObserverStore } from './redis_store.ts'

const REDIS_URL = process.env.REDIS_URL ?? ''
const ENC = new TextEncoder()
const DEC = new TextDecoder()

function decode(files: Map<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of files) out[k] = DEC.decode(v)
  return out
}

describe.skipIf(REDIS_URL === '')('RedisObserverStore', () => {
  let store: RedisObserverStore

  beforeEach(async () => {
    // One prefix per test: a shared one lets a parallel run's clear() wipe
    // what this test has just written.
    store = new RedisObserverStore({ url: REDIS_URL, keyPrefix: `test:observer:${randomUUID()}:` })
    await store.clear()
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  it('append creates and extends', async () => {
    await store.append('/d/s.jsonl', ENC.encode('a\n'))
    await store.append('/d/s.jsonl', ENC.encode('b\n'))
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': 'a\nb\n' })
  })

  it('write overwrites', async () => {
    await store.append('/d/s.jsonl', ENC.encode('old\n'))
    await store.write('/d/s.jsonl', ENC.encode('new\n'))
    expect(decode(await store.readAll())).toEqual({ '/d/s.jsonl': 'new\n' })
  })

  it('clear empties the namespace', async () => {
    await store.append('/d/a.jsonl', ENC.encode('x\n'))
    await store.append('/d/b.jsonl', ENC.encode('y\n'))
    await store.clear()
    expect((await store.readAll()).size).toBe(0)
  })

  it('readMatching filters by suffix', async () => {
    await store.append('/d1/s1.jsonl', ENC.encode('a\n'))
    await store.append('/d1/s2.jsonl', ENC.encode('b\n'))
    await store.append('/d2/s1.jsonl', ENC.encode('c\n'))
    expect(decode(await store.readMatching('/s1.jsonl'))).toEqual({
      '/d1/s1.jsonl': 'a\n',
      '/d2/s1.jsonl': 'c\n',
    })
  })

  it('backs an Observer round-trip', async () => {
    const obs = new Observer(store)
    await obs.logClear('s1')
    const events = await obs.events()
    const last = events[events.length - 1]
    expect(last?.type).toBe('clear')
    expect(last?.session).toBe('s1')
  })
})
