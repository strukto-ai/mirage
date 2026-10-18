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
import { Activity } from './activity.ts'

it.each(['eof', 'error', 'close'])('usage ends with its stream (%s)', async (finish) => {
  const activity = new Activity()
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(new Uint8Array([1]))
    if (finish === 'error') throw new Error('read failed')
  }
  const source = activity.hold(chunks())
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
})

it.each([false, true])('close waits for a pending pull (wrapped=%s)', async (wrapped) => {
  const activity = new Activity()
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
  const raw = chunks()
  const delegated: AsyncIterableIterator<Uint8Array> = {
    next: () => raw.next(),
    return: () => raw.return(undefined),
    [Symbol.asyncIterator]() {
      return this
    },
  }
  const source = activity.hold(wrapped ? delegated : raw)
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

it('close ends a pull waiting on a source that only its close ends', async () => {
  const activity = new Activity()
  let wake = (): void => undefined
  const idle: AsyncIterableIterator<Uint8Array> = {
    next: () =>
      new Promise((resolve) => {
        wake = () => {
          resolve({ value: undefined, done: true })
        }
      }),
    return: () => {
      wake()
      return Promise.resolve({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  const source = activity.hold(idle)
  if (source instanceof Uint8Array) throw new Error('expected stream')
  const iterator = source[Symbol.asyncIterator]()
  const pulling = iterator.next()
  await Promise.resolve()
  await iterator.return?.()
  expect((await pulling).done).toBe(true)
  await activity.wait()
})

it('close retains usage through cleanup and shares concurrent returns', async () => {
  const activity = new Activity()
  let wake = (): void => undefined
  let clean = (): void => undefined
  const cleanup = new Promise<void>((resolve) => {
    clean = resolve
  })
  let closes = 0
  const source: AsyncIterableIterator<Uint8Array> = {
    next: () =>
      new Promise((resolve) => {
        wake = () => {
          resolve({ done: true, value: undefined })
        }
      }),
    return: async () => {
      closes++
      wake()
      await cleanup
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  const held = activity.hold(source)
  if (held instanceof Uint8Array) throw new Error('expected stream')
  const iterator = held[Symbol.asyncIterator]()
  const pulling = iterator.next()
  let idle = false
  const waiting = activity.wait().then(() => {
    idle = true
  })
  const closing = iterator.return?.()
  const again = iterator.return?.()
  try {
    expect((await pulling).done).toBe(true)
    await Promise.resolve()
    expect(idle).toBe(false)
    expect(closes).toBe(1)
    clean()
    await Promise.all([closing, again, waiting])
    await iterator.return?.()
    expect(closes).toBe(1)
  } finally {
    clean()
    await Promise.allSettled([pulling, closing, again, waiting])
  }
})

it.each(['throw', 'reject'])(
  'a failed close releases usage without retrying (%s)',
  async (kind) => {
    const activity = new Activity()
    const failure = new Error('close failed')
    let closes = 0
    const source: AsyncIterableIterator<Uint8Array> = {
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: () => {
        closes++
        if (kind === 'throw') throw failure
        return Promise.reject(failure)
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
    const held = activity.hold(source)
    if (held instanceof Uint8Array) throw new Error('expected stream')
    const iterator = held[Symbol.asyncIterator]()
    await expect(iterator.return?.()).rejects.toBe(failure)
    await expect(iterator.return?.()).rejects.toBe(failure)
    await activity.wait()
    expect(closes).toBe(1)
  },
)
