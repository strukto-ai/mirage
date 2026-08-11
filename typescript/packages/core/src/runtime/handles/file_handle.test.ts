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
import { FileHandle, mergeWrites } from './file_handle.ts'
import { NO_WRITE } from './flush.ts'

const enc = new TextEncoder()

describe('FileHandle', () => {
  it('positions by append and seeds the flush facts', () => {
    const h = FileHandle.opened('/f', enc.encode('abc'), { writable: true, append: true })
    expect([h.pos, h.baseLen, h.lowWrite, h.dirty]).toEqual([3, 3, NO_WRITE, false])
    const fresh = FileHandle.opened('/f', enc.encode('abc'), { writable: false, append: false })
    expect(fresh.pos).toBe(0)
    expect(fresh.writable).toBe(false)
  })

  it('reads forward and never moves the position backward', () => {
    const h = FileHandle.opened('/f', enc.encode('hello'), { writable: false, append: false })
    expect(h.read(2)).toEqual(enc.encode('he'))
    expect(h.read(null)).toEqual(enc.encode('llo'))
    h.pos = 99
    expect(h.read(4)).toEqual(new Uint8Array())
    expect(h.pos).toBe(99)
  })

  it('preads without moving the position', () => {
    const h = FileHandle.opened('/f', enc.encode('hello'), { writable: false, append: false })
    expect(h.pread(1, 3)).toEqual(enc.encode('ell'))
    expect(h.pos).toBe(0)
  })

  it('writes extend, zero-fill, and track the flush facts', () => {
    const h = FileHandle.opened('/f', enc.encode('abc'), { writable: true, append: true })
    h.write(enc.encode('XY'))
    expect(h.buf).toEqual(enc.encode('abcXY'))
    expect(h.dirty).toBe(true)
    h.pwrite(7, enc.encode('Z'))
    expect(h.buf).toEqual(new Uint8Array([...enc.encode('abcXY'), 0, 0, ...enc.encode('Z')]))
    expect(h.lowWrite).toBe(3)
    expect(h.flushPlan()).toEqual([
      'append',
      new Uint8Array([...enc.encode('XY'), 0, 0, ...enc.encode('Z')]),
    ])
    h.pwrite(0, enc.encode('q'))
    expect(h.flushPlan()[0]).toBe('write')
  })

  it('seek answers null for a bad whence or a negative target', () => {
    const h = FileHandle.opened('/f', enc.encode('hello'), { writable: false, append: false })
    expect(h.seek(-2, 2)).toBe(3)
    expect(h.seek(-9, 0)).toBeNull()
    expect(h.seek(0, 7)).toBeNull()
    expect(h.pos).toBe(3)
  })

  it('truncate rewrites history in both directions', () => {
    const h = FileHandle.opened('/f', enc.encode('hello'), { writable: true, append: true })
    h.truncate(2)
    expect(h.buf).toEqual(enc.encode('he'))
    expect(h.lowWrite).toBe(0)
    h.truncate(4)
    expect(h.buf).toEqual(new Uint8Array([...enc.encode('he'), 0, 0]))
    expect(h.flushPlan()[0]).toBe('write')
  })

  it('eof tracks the position', () => {
    const h = FileHandle.opened('/f', enc.encode('ab'), { writable: false, append: false })
    expect(h.eof).toBe(false)
    h.read(null)
    expect(h.eof).toBe(true)
  })
})

describe('mergeWrites', () => {
  it('splices, pads, and keeps arrival order', () => {
    expect(mergeWrites(enc.encode('hello'), [[1, enc.encode('XY')]])).toEqual(enc.encode('hXYlo'))
    expect(mergeWrites(enc.encode('ab'), [[4, enc.encode('z')]])).toEqual(
      new Uint8Array([...enc.encode('ab'), 0, 0, ...enc.encode('z')]),
    )
    expect(
      mergeWrites(new Uint8Array(), [
        [0, enc.encode('new')],
        [1, enc.encode('O')],
      ]),
    ).toEqual(enc.encode('nOw'))
  })
})
