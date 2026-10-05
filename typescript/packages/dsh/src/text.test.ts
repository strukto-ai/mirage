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
import { StreamTail, TailBuffer } from './text.ts'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('TailBuffer', () => {
  it('keeps everything while it fits', () => {
    const buffer = new TailBuffer(16)
    expect(buffer.append(bytes('abc'))).toBe(false)
    expect(buffer.append(bytes('def'))).toBe(false)
    expect(buffer.take()).toBe('abcdef')
  })

  it('drains empty and stays empty', () => {
    const buffer = new TailBuffer(16)
    expect(buffer.take()).toBe('')
    buffer.append(bytes('x'))
    expect(buffer.take()).toBe('x')
    expect(buffer.take()).toBe('')
  })

  it('reports the drop and keeps the newest bytes', () => {
    const buffer = new TailBuffer(4)
    expect(buffer.append(bytes('abc'))).toBe(false)
    expect(buffer.append(bytes('def'))).toBe(true)
    expect(buffer.take()).toBe('cdef')
  })

  it('drops whole chunks and then part of one', () => {
    const buffer = new TailBuffer(3)
    buffer.append(bytes('aaaa'))
    buffer.append(bytes('bb'))
    buffer.append(bytes('cc'))
    expect(buffer.take()).toBe('bcc')
  })

  it('drops a chunk larger than the whole budget down to its tail', () => {
    const buffer = new TailBuffer(3)
    expect(buffer.append(bytes('abcdefgh'))).toBe(true)
    expect(buffer.take()).toBe('fgh')
  })

  it('re-aligns a head that lands mid-character', () => {
    const buffer = new TailBuffer(3)
    // "aaéé" is six bytes; the last three start inside the third character.
    buffer.append(bytes('aaéé'))
    expect(buffer.take()).toBe('é')
  })

  it('keeps a multi-byte character whole when the cap lands on its boundary', () => {
    const buffer = new TailBuffer(3)
    buffer.append(bytes('aaaé'))
    expect(buffer.take()).toBe('aé')
  })
})

describe('StreamTail', () => {
  it('leaves a character it holds only part of for the next read', () => {
    const tail = new StreamTail(64)
    const e = bytes('é')
    tail.append(bytes('a'))
    tail.append(e.subarray(0, 1))
    const first = tail.readFrom(0)
    expect(first).toMatchObject({ text: 'a', nextOffset: 1, lossy: false })
    tail.append(e.subarray(1))
    expect(tail.readFrom(first.nextOffset)).toMatchObject({ text: 'é', nextOffset: 3 })
  })

  it('decodes through the last byte once the stream has ended', () => {
    const tail = new StreamTail(64)
    tail.append(bytes('a'))
    tail.append(bytes('é').subarray(0, 1))
    tail.end()
    expect(tail.readFrom(0)).toMatchObject({ text: 'a\uFFFD', nextOffset: 2 })
  })

  it('shows a byte that can open no character at once', () => {
    const tail = new StreamTail(64)
    tail.append(new Uint8Array([0x61, 0xff]))
    expect(tail.readFrom(0)).toMatchObject({ text: 'a\uFFFD', nextOffset: 2 })
  })

  it('reads only what follows the offset', () => {
    const tail = new StreamTail(64)
    tail.append(bytes('abc'))
    tail.append(bytes('déf'))
    expect(tail.readFrom(4)).toMatchObject({ text: 'éf', nextOffset: 7, lossy: false })
  })

  it('reads lossy once the offset slid out of the tail', () => {
    const tail = new StreamTail(3)
    tail.append(bytes('abc'))
    tail.append(bytes('def'))
    expect(tail.truncated).toBe(true)
    expect(tail.readFrom(1)).toMatchObject({ text: 'def', nextOffset: 6, lossy: true })
  })
})
