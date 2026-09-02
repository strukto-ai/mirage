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
import { WriteBuffer } from './writebuf.ts'

const buf = (s: string): Buffer => Buffer.from(s)

describe('WriteBuffer.merge', () => {
  it('applies out-of-order writes by offset', () => {
    const merged = WriteBuffer.merge(buf(''), [
      [4, buf('dd')],
      [0, buf('aa')],
      [2, buf('bb')],
    ])
    expect(merged.toString()).toBe('aabbdd')
  })

  it('lets a later overlapping write win', () => {
    // The macOS client issues overlapping WRITEs during a plain cp
    // (it corrupts nfsserve's own demo); arrival order with
    // later-wins is what keeps the copy intact.
    expect(
      WriteBuffer.merge(buf(''), [
        [0, buf('aaaa')],
        [1, buf('XX')],
      ]).toString(),
    ).toBe('aXXa')
  })

  it('zero-fills a gap past the base', () => {
    const merged = WriteBuffer.merge(buf('ab'), [[4, buf('z')]])
    expect([...merged]).toEqual([97, 98, 0, 0, 122])
  })
})

describe('WriteBuffer', () => {
  it('buffers rather than storing, and reports pending state', () => {
    const w = new WriteBuffer()
    expect(w.hasPending(1)).toBe(false)
    w.append(1, 0, buf('hi'))
    expect(w.hasPending(1)).toBe(true)
    expect(w.pendingIds()).toEqual([1])
  })

  it('signals when a handle reaches the byte cap', () => {
    const w = new WriteBuffer()
    expect(w.append(1, 0, buf('abc'), 10)).toBe(false)
    expect(w.append(1, 3, buf('defghij'), 10)).toBe(true)
  })

  it('reports the size a client should see', () => {
    const w = new WriteBuffer()
    w.append(1, 100, buf('xyz'))
    expect(w.pendingSize(1, 0)).toBe(103)
    expect(w.pendingSize(2, 500)).toBe(500)
  })

  it('keeps a larger base size', () => {
    const w = new WriteBuffer()
    w.append(1, 0, buf('x'))
    expect(w.pendingSize(1, 500)).toBe(500)
  })

  it('reads through pending overlapping writes', () => {
    const w = new WriteBuffer()
    w.append(7, 0, buf('AAAAAA'))
    w.append(7, 3, buf('BBB'))
    w.append(7, 5, buf('CC'))
    expect(w.overlay(7, buf('0123456789'), 0, 10).toString()).toBe('AAABBCC789')
  })

  it('reads stored bytes when nothing is pending', () => {
    expect(new WriteBuffer().overlay(1, buf('hello'), 1, 3).toString()).toBe('ell')
  })

  it('clips pending writes past a truncate', () => {
    const w = new WriteBuffer()
    w.append(1, 0, buf('abcdef'))
    w.clip(1, 3)
    expect(WriteBuffer.merge(buf(''), w.take(1)).toString()).toBe('abc')
  })

  it('clip preserves overlap resolution', () => {
    const w = new WriteBuffer()
    w.append(7, 0, buf('AAAAAA'))
    w.append(7, 4, buf('BBBB'))
    w.clip(7, 6)
    expect(WriteBuffer.merge(buf(''), w.take(7)).toString()).toBe('AAAABB')
  })

  it('clip to zero forgets the handle', () => {
    const w = new WriteBuffer()
    w.append(1, 2, buf('xx'))
    w.clip(1, 0)
    expect(w.hasPending(1)).toBe(false)
  })

  it('drop discards without storing', () => {
    // What a removed file needs: storing would bring it back.
    const w = new WriteBuffer()
    w.append(1, 0, buf('doomed'))
    w.drop(1)
    expect(w.take(1)).toEqual([])
  })

  it('take drains the handle', () => {
    const w = new WriteBuffer()
    w.append(1, 0, buf('x'))
    expect(w.take(1).length).toBe(1)
    expect(w.hasPending(1)).toBe(false)
  })

  it('idleIds reports only handles past the threshold', () => {
    const w = new WriteBuffer()
    w.append(1, 0, buf('old'), undefined, 100)
    w.append(2, 0, buf('new'), undefined, 200)
    expect(w.idleIds(50, 201)).toEqual([1])
  })

  it('copies the payload so a reused caller buffer cannot mutate it', () => {
    const w = new WriteBuffer()
    const shared = Buffer.from('abc')
    w.append(1, 0, shared)
    shared.write('zzz')
    expect(WriteBuffer.merge(buf(''), w.take(1)).toString()).toBe('abc')
  })
})
