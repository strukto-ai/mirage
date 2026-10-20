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
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { openStream } from '../../../rs/stream.ts'
import { materialize } from '../../../io/types.ts'
import { isStdin, operandLabel, stdinStat, stdinStream, streamOutput } from './stream.ts'

function operand(raw: string, virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: '/',
    vfsPath: virtual.slice(1),
    resolved: true,
    rawPath: raw,
  })
}

describe('operandLabel', () => {
  it('names only a dash stdin', () => {
    // GNU grep, head and tail call only `-` standard input: /dev/stdin reads
    // the same bytes and is named as the path it is.
    const dash = operand('-', '/-')
    const dev = operand('/dev/stdin', '/dev/stdin')
    expect([isStdin(dash), isStdin(dev)]).toEqual([true, true])
    expect(operandLabel(dash, '(standard input)')).toBe('(standard input)')
    expect(operandLabel(dev, '(standard input)')).toBe('/dev/stdin')
    expect(operandLabel(operand('a.txt', '/data/a.txt'), '-')).toBe('a.txt')
  })
})

describe('dash', () => {
  it('keeps a dash a file and /dev/stdin stdin when false', () => {
    // util-linux rev and binutils strings open `-` as a path; only
    // /dev/stdin reads stdin for them.
    const dash = operand('-', '/-')
    const dev = operand('/dev/stdin', '/dev/stdin')
    expect([isStdin(dash, false), isStdin(dev, false)]).toEqual([false, true])
  })

  it('is honored by stdinStat and stdinStream', async () => {
    const backendHits: string[] = []
    const stat = (p: PathSpec): Promise<FileStat> => {
      backendHits.push(p.virtual)
      return Promise.resolve(new FileStat({ name: '-', type: FileType.FILE }))
    }
    const read = (p: PathSpec): AsyncIterable<Uint8Array> => {
      backendHits.push(p.virtual)
      return (async function* gen() {
        await Promise.resolve()
        yield new TextEncoder().encode('backend')
      })()
    }
    const dash = operand('-', '/-')
    const dev = operand('/dev/stdin', '/dev/stdin')
    const probe = stdinStat(stat, false)
    expect((await probe(dev)).type).toBe(FileType.FIFO)
    expect((await probe(dash)).type).toBe(FileType.FILE)
    const stream = stdinStream(read, new TextEncoder().encode('piped'), false, false)
    const DEC = new TextDecoder()
    expect(DEC.decode(await materialize(stream(dev)))).toBe('piped')
    expect(DEC.decode(await materialize(stream(dash)))).toBe('backend')
    expect(backendHits).toEqual(['/-', '/-'])
  })
})

it('closes an unstarted output without pulling its source', async () => {
  let closed = 0
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      throw new Error('unstarted output pulled input')
    },
    return() {
      closed += 1
      return Promise.resolve({ done: true, value: undefined })
    },
  }
  const output = streamOutput(
    await openStream('base64', { mode: 'decode', ignore_garbage: false }),
    source,
  )
  await output.return?.()
  await output.return?.()
  expect(closed).toBe(1)
})

it.each(['late bytes', 'stalled input'])(
  'stops a pending read before closing its native stream (%s)',
  async (inputState) => {
    let enter: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let release: (result: IteratorResult<Uint8Array>) => void = () => undefined
    const input = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      release = resolve
    })
    let closed = 0
    const source: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        enter()
        return input
      },
      return() {
        closed += 1
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    const native = await openStream('base64', { mode: 'decode', ignore_garbage: false })
    const output = streamOutput(native, source)
    const reading = output.next()
    const read = reading.then(
      (result) => result,
      (error: unknown) => error,
    )
    await entered
    const closing = output.return?.()
    const prompt = await Promise.race([
      Promise.resolve(closing).then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(false)
        }, 50),
      ),
    ])
    if (inputState === 'late bytes' || !prompt)
      release({ done: false, value: new TextEncoder().encode('YWJj') })
    await closing
    const result = await read
    await output.return?.()
    expect(result).toEqual({ done: true, value: undefined })
    expect(prompt).toBe(true)
    expect(closed).toBe(1)
    expect(native.live).toBe(false)
    expect(await output.next()).toEqual({ done: true, value: undefined })
    const fresh = streamOutput(
      await openStream('base64', { mode: 'decode', ignore_garbage: false }),
      new TextEncoder().encode('YWJj'),
    )
    expect(await materialize(fresh)).toEqual(new TextEncoder().encode('abc'))
  },
)

it('propagates caller cancellation during a pending read', async () => {
  let enter: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const abort = new AbortController()
  const reason = new Error('caller cancelled')
  let closed = 0
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      enter()
      return new Promise<IteratorResult<Uint8Array>>(() => undefined)
    },
    return() {
      closed += 1
      return Promise.resolve({ done: true, value: undefined })
    },
  }
  const native = await openStream('base64', { mode: 'decode', ignore_garbage: false })
  const output = streamOutput(native, source, abort.signal)
  const reading = output.next()
  const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError', cause: reason })
  await entered
  abort.abort(reason)
  await rejected
  await output.return?.()
  expect(closed).toBe(1)
  expect(native.live).toBe(false)
})
