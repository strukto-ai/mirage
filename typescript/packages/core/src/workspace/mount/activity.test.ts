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

import { expect, it } from 'vitest'
import { CachableAsyncIterator } from '../../io/cachable_iterator.ts'
import { ResourceActivity } from './activity.ts'

it.each(['eof', 'error', 'close', 'bounded'])(
  'resource usage ends with its stream (%s)',
  async (finish) => {
    const activity = new ResourceActivity()
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(new Uint8Array([1]))
      if (finish === 'error') throw new Error('read failed')
    }
    const source = activity.hold(
      finish === 'bounded' ? new CachableAsyncIterator(chunks()) : chunks(),
    )
    if (source instanceof Uint8Array) throw new Error('expected stream')
    let done = false
    const waiting = activity.wait().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    const consume = async (): Promise<void> => {
      for await (const chunk of source) expect(chunk).toEqual(new Uint8Array([1]))
    }
    if (finish === 'close') {
      const iter = source[Symbol.asyncIterator]()
      await iter.return?.()
      await iter.return?.()
    } else if (source instanceof CachableAsyncIterator) {
      expect(await source.drainBounded(0)).toBeNull()
    } else if (finish === 'error') {
      await expect(consume()).rejects.toThrow('read failed')
    } else {
      await consume()
    }
    await waiting
    const release = activity.acquire()
    done = false
    const next = activity.wait().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    release()
    await next
  },
)

it('exhausted cache streams do not keep a resource active', async () => {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(new Uint8Array([1]))
  }
  const cached = new CachableAsyncIterator(chunks())
  await cached.drain()
  const activity = new ResourceActivity()
  activity.hold(cached)
  await activity.wait()
})

it('close waits for a pending pull before releasing usage', async () => {
  const activity = new ResourceActivity()
  let entered = (): void => undefined
  let resume = (): void => undefined
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const release = new Promise<void>((resolve) => {
    resume = resolve
  })
  async function* chunks(): AsyncGenerator<Uint8Array> {
    entered()
    await release
    yield new Uint8Array([1])
  }
  const source = activity.hold(chunks())
  if (source instanceof Uint8Array) throw new Error('expected stream')
  const iterator = source[Symbol.asyncIterator]()
  const pulling = iterator.next()
  await started
  let closed = false
  let idle = false
  const closing = iterator.return?.().then(() => {
    closed = true
  })
  const waiting = activity.wait().then(() => {
    idle = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(idle).toBe(false)
  resume()
  expect((await pulling).value).toEqual(new Uint8Array([1]))
  await Promise.all([closing, waiting])
})
