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

import { PipeClosed } from '../errors.ts'
import { PipeConsole } from './pipe.ts'
import { Channel } from './types.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('PipeConsole', () => {
  it('buffers writes before the reader takes them', async () => {
    const pipe = new PipeConsole()
    for (const chunk of ['1\n', '2\n', '3\n']) await pipe.emit(Channel.STDOUT, enc(chunk))
    pipe.end()
    const stream = pipe.stream()
    const first = await stream.next()
    expect(dec(first.value as Uint8Array)).toBe('1\n')
    await stream.return(undefined)
    await pipe.drain()
    await expect(pipe.emit(Channel.STDOUT, enc('4\n'))).rejects.toBeInstanceOf(PipeClosed)
  })

  it('releases a draining writer on reader close and refuses more output', async () => {
    const pipe = new PipeConsole()
    await pipe.emit(Channel.STDOUT, enc('first'))
    let drained = false
    const drain = pipe.drain().then(() => {
      drained = true
    })
    const stream = pipe.stream()
    const first = await stream.next()
    expect(dec(first.value as Uint8Array)).toBe('first')
    await tick()
    expect(drained).toBe(false)
    await stream.return(undefined)
    await drain
    await expect(pipe.emit(Channel.STDOUT, enc('second'))).rejects.toBeInstanceOf(PipeClosed)
  })

  it('blocks the writer on a full buffer until the reader advances', async () => {
    const pipe = new PipeConsole()
    await pipe.emit(Channel.STDOUT, new Uint8Array(65536))
    let written = false
    const writer = pipe.emit(Channel.STDOUT, enc('y')).then(() => {
      written = true
    })
    await tick()
    expect(written).toBe(false)
    const stream = pipe.stream()
    const full = await stream.next()
    expect((full.value as Uint8Array).byteLength).toBe(16384)
    await writer
    for (let i = 0; i < 3; i += 1)
      expect(((await stream.next()).value as Uint8Array).byteLength).toBe(16384)
    expect(dec((await stream.next()).value as Uint8Array)).toBe('y')
    await stream.return(undefined)
  })

  it('lets a writer that is not blocked finish its burst after the reader stops', async () => {
    const pipe = new PipeConsole()
    await pipe.emit(Channel.STDOUT, enc('1\n'))
    const stream = pipe.stream()
    await stream.next()
    await stream.return(undefined)
    await pipe.emit(Channel.STDOUT, enc('2\n'))
    await pipe.drain()
    expect(pipe.closedReader).toBe(true)
  })

  it('keeps stderr without waiting for a stdout reader', async () => {
    const pipe = new PipeConsole()
    await pipe.emit(Channel.STDERR, enc('warning'))
    expect(dec(await pipe.snapshot(Channel.STDERR))).toBe('warning')
  })
})
