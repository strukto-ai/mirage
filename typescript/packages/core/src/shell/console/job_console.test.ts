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

import { KILLED_OUTCOME } from './constants.ts'
import { Channel } from './types.ts'
import { exitOutcome } from './utils.ts'
import { JobConsole } from './job_console.ts'
import { RAMConsoleStore } from './ram.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

describe('RAMConsoleStore', () => {
  it('assigns increasing seq', async () => {
    const store = new RAMConsoleStore()
    const first = await store.append(Channel.STDOUT, enc('a'))
    const second = await store.append(Channel.STDERR, enc('b'))
    expect([first.seq, second.seq]).toEqual([0, 1])
  })

  it('reads a window and reports the next cursor', async () => {
    const store = new RAMConsoleStore()
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [chunks, next, truncated] = await store.readFrom(1)
    expect(chunks.map((c) => dec(c.data))).toEqual(['b', 'c'])
    expect(next).toBe(3)
    expect(truncated).toBe(false)
  })

  it('honours a limit', async () => {
    const store = new RAMConsoleStore()
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [chunks, next] = await store.readFrom(0, 2)
    expect(chunks.map((c) => dec(c.data))).toEqual(['a', 'b'])
    expect(next).toBe(2)
  })

  it('reading from the end is empty, not an error', async () => {
    const store = new RAMConsoleStore()
    await store.append(Channel.STDOUT, enc('a'))
    const [chunks, next] = await store.readFrom(1)
    expect(chunks).toEqual([])
    expect(next).toBe(1)
  })

  it('drops the oldest chunks and reports truncation', async () => {
    const store = new RAMConsoleStore(2)
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [chunks, , truncated] = await store.readFrom(0)
    expect(truncated).toBe(true)
    expect(chunks.map((c) => dec(c.data))).toEqual(['b', 'c'])
  })

  it('never trims the terminal control chunk', async () => {
    const store = new RAMConsoleStore(2)
    await store.append(Channel.STDOUT, enc('payload'))
    await store.append(Channel.CONTROL, enc('exit:0'))
    const [chunks] = await store.readFrom(0)
    expect(chunks.map((c) => c.channel)).toEqual([Channel.CONTROL])
  })

  it('does not report truncation to a reader still in range', async () => {
    const store = new RAMConsoleStore(2)
    for (const p of ['a', 'b', 'c']) await store.append(Channel.STDOUT, enc(p))
    const [, , truncated] = await store.readFrom(2)
    expect(truncated).toBe(false)
  })

  it('waits until the next append', async () => {
    const store = new RAMConsoleStore()
    let woke = false
    const waiter = store.wait(0).then(() => {
      woke = true
    })
    await Promise.resolve()
    expect(woke).toBe(false)
    await store.append(Channel.STDOUT, enc('a'))
    await waiter
    expect(woke).toBe(true)
  })

  it('returns immediately when data already exists', async () => {
    const store = new RAMConsoleStore()
    await store.append(Channel.STDOUT, enc('a'))
    await store.wait(0)
  })

  it('close releases blocked readers', async () => {
    const store = new RAMConsoleStore()
    const waiter = store.wait(0)
    await store.close()
    await waiter
  })
})

describe('JobConsole', () => {
  it('reads emitted chunks from the start', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('hello\n'))
    await c.emit(Channel.STDERR, enc('oops\n'))
    const [chunks, next] = await c.readFrom(0)
    expect(chunks.map((k) => [k.channel, dec(k.data)])).toEqual([
      [Channel.STDOUT, 'hello\n'],
      [Channel.STDERR, 'oops\n'],
    ])
    expect(next).toBe(2)
  })

  it('yields each chunk once across reads from the cursor', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('first'))
    const [, cursor] = await c.readFrom(0)
    await c.emit(Channel.STDOUT, enc('second'))
    const [chunks] = await c.readFrom(cursor)
    expect(chunks.map((k) => dec(k.data))).toEqual(['second'])
  })

  it('interleaves channels in production order', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('one\n'))
    await c.emit(Channel.STDERR, enc('two\n'))
    await c.emit(Channel.STDOUT, enc('three\n'))
    expect(dec(await c.snapshot())).toBe('one\ntwo\nthree\n')
  })

  it('snapshots one channel', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('out'))
    await c.emit(Channel.STDERR, enc('err'))
    expect(dec(await c.snapshot(Channel.STDOUT))).toBe('out')
    expect(dec(await c.snapshot(Channel.STDERR))).toBe('err')
  })

  it('omits the control chunk from a snapshot', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('out'))
    await c.finish(exitOutcome(0))
    expect(dec(await c.snapshot())).toBe('out')
  })

  it('records the outcome as a chunk', async () => {
    const c = new JobConsole()
    await c.finish(exitOutcome(3))
    const [chunks] = await c.readFrom(0)
    expect(chunks.map((k) => [k.channel, dec(k.data)])).toEqual([[Channel.CONTROL, 'exit:3']])
    expect(c.finished).toBe(true)
  })

  it('finish is idempotent', async () => {
    const c = new JobConsole()
    await c.finish(exitOutcome(0))
    await c.finish(KILLED_OUTCOME)
    const [chunks] = await c.readFrom(0)
    expect(chunks.map((k) => dec(k.data))).toEqual(['exit:0'])
  })

  it('follow ends at the control chunk', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('a'))
    await c.finish(exitOutcome(0))
    const seen: string[] = []
    for await (const chunk of c.follow()) seen.push(dec(chunk.data))
    expect(seen).toEqual(['a', 'exit:0'])
  })

  it('follow delivers chunks as they arrive', async () => {
    const c = new JobConsole()
    const seen: string[] = []
    const follower = (async () => {
      for await (const chunk of c.follow()) seen.push(dec(chunk.data))
    })()
    await Promise.resolve()

    await c.emit(Channel.STDOUT, enc('early'))
    while (seen.length === 0) await Promise.resolve()
    expect(seen).toEqual(['early'])

    await c.finish(exitOutcome(0))
    await follower
    expect(seen).toEqual(['early', 'exit:0'])
  })

  it('follow can start from a later cursor', async () => {
    const c = new JobConsole()
    await c.emit(Channel.STDOUT, enc('skipped'))
    await c.emit(Channel.STDOUT, enc('kept'))
    await c.finish(exitOutcome(0))
    const seen: string[] = []
    for await (const chunk of c.follow(1)) seen.push(dec(chunk.data))
    expect(seen).toEqual(['kept', 'exit:0'])
  })

  it('waitFinished resolves once the job ends', async () => {
    const c = new JobConsole()
    let done = false
    const joiner = c.waitFinished().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    await c.finish(exitOutcome(0))
    await joiner
    expect(done).toBe(true)
  })

  it('waitFinished returns immediately when already finished', async () => {
    const c = new JobConsole()
    await c.finish(exitOutcome(0))
    await c.waitFinished()
  })

  it('waitFinished survives an outcome bigger than the budget', async () => {
    const c = new JobConsole(new RAMConsoleStore(2))
    await c.emit(Channel.STDOUT, enc('payload'))
    await c.finish(exitOutcome(0))
    await c.waitFinished()
  })

  it('surfaces truncation to the reader', async () => {
    const c = new JobConsole(new RAMConsoleStore(2))
    for (const p of ['a', 'b', 'c']) await c.emit(Channel.STDOUT, enc(p))
    const [chunks, , truncated] = await c.readFrom(0)
    expect(truncated).toBe(true)
    expect(chunks.map((k) => dec(k.data))).toEqual(['b', 'c'])
  })

  // close() releases the registered waiter once, but readers loop: they
  // re-read, find no CONTROL chunk, and wait again. Without closed state
  // on the store that second wait never resolves.
  it('close releases a reader parked on waitFinished', async () => {
    const c = new JobConsole()
    let joined = false
    const task = c.waitFinished().then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)

    await c.close()
    await task

    expect(joined).toBe(true)
  })

  it('close ends a follow in progress', async () => {
    const c = new JobConsole()
    const seen: string[] = []
    const task = (async () => {
      for await (const chunk of c.follow()) seen.push(dec(chunk.data))
    })()
    await c.emit(Channel.STDOUT, enc('a'))
    await Promise.resolve()

    await c.close()
    await task

    expect(seen).toEqual(['a'])
  })

  it('waitFinished returns immediately once closed', async () => {
    const c = new JobConsole()
    await c.close()
    await c.waitFinished()
  })
})
