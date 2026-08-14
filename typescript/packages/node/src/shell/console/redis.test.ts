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
import { Channel, JobConsole } from '@struktoai/mirage-core'
import { afterEach, describe, expect, it } from 'vitest'
import { RedisConsoleStore } from './redis.ts'

const REDIS_URL = process.env.REDIS_URL ?? ''
const ENC = new TextEncoder()
const DEC = new TextDecoder()

describe.skipIf(REDIS_URL === '')('RedisConsoleStore', () => {
  const opened: RedisConsoleStore[] = []

  function makeStore(prefix: string): RedisConsoleStore {
    const store = new RedisConsoleStore({ url: REDIS_URL, keyPrefix: prefix })
    opened.push(store)
    return store
  }

  afterEach(async () => {
    for (const store of opened.splice(0)) {
      await store.clear()
      await store.close()
    }
  })

  it('append assigns dense seqs and readFrom returns them', async () => {
    const store = makeStore(`test:console:${randomUUID()}:`)
    const first = await store.append(Channel.STDOUT, ENC.encode('one'))
    const second = await store.append(Channel.STDERR, ENC.encode('two'))
    expect([first.seq, second.seq]).toEqual([0, 1])
    const [chunks, next, truncated] = await store.readFrom(0)
    expect(chunks.map((c) => [c.seq, c.channel, DEC.decode(c.data)])).toEqual([
      [0, Channel.STDOUT, 'one'],
      [1, Channel.STDERR, 'two'],
    ])
    expect(next).toBe(2)
    expect(truncated).toBe(false)
  })

  it('readFrom honors cursor and limit', async () => {
    const store = makeStore(`test:console:${randomUUID()}:`)
    for (const i of [0, 1, 2, 3]) {
      await store.append(Channel.STDOUT, ENC.encode(String(i)))
    }
    const [window, next] = await store.readFrom(1, 2)
    expect(window.map((c) => DEC.decode(c.data))).toEqual(['1', '2'])
    expect(next).toBe(3)
    const [empty, clamped] = await store.readFrom(9)
    expect(empty).toEqual([])
    expect(clamped).toBe(4)
  })

  it('wait wakes on append and returns when already satisfied', async () => {
    const store = makeStore(`test:console:${randomUUID()}:`)
    await store.append(Channel.STDOUT, ENC.encode('x'))
    await store.wait(0)
    let woke = false
    const waiter = store.wait(1).then(() => {
      woke = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(woke).toBe(false)
    await store.append(Channel.STDOUT, ENC.encode('y'))
    await waiter
    expect(woke).toBe(true)
  })

  it('close releases a parked waiter', async () => {
    const store = makeStore(`test:console:${randomUUID()}:`)
    const waiter = store.wait(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await store.close()
    await waiter
  })

  it('follow across two instances ends at the control chunk', async () => {
    // The cross-process topology in miniature: the two instances share
    // nothing but the key prefix.
    const prefix = `test:console:${randomUUID()}:`
    const writer = new JobConsole(makeStore(prefix))
    await writer.emit(Channel.STDOUT, ENC.encode('out'))
    await writer.emit(Channel.STDERR, ENC.encode('err'))
    await writer.finish('exit:0')
    const reader = new JobConsole(makeStore(prefix))
    const got: [string, string][] = []
    for await (const chunk of reader.follow()) {
      got.push([chunk.channel, DEC.decode(chunk.data)])
    }
    expect(got).toEqual([
      [Channel.STDOUT, 'out'],
      [Channel.STDERR, 'err'],
      [Channel.CONTROL, 'exit:0'],
    ])
  })
})
