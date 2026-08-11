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
import { FileHandle, FileTable, mergeWrites, NO_WRITE, parseMode, planFlush } from './handles.ts'

const enc = new TextEncoder()

describe('planFlush', () => {
  it('ships a tail when the handle only extended the file', () => {
    expect(planFlush(3, 3, enc.encode('abcXYZ'))).toEqual(['append', enc.encode('XYZ')])
  })

  it('ships the whole file when history was rewritten', () => {
    expect(planFlush(3, 0, enc.encode('ZZZdef'))).toEqual(['write', enc.encode('ZZZdef')])
  })

  it('ships the whole file for a new one', () => {
    expect(planFlush(0, 0, enc.encode('fresh'))).toEqual(['write', enc.encode('fresh')])
  })

  it('ships the whole file when the buffer shrank', () => {
    expect(planFlush(6, 6, enc.encode('abc'))).toEqual(['write', enc.encode('abc')])
  })
})

describe('parseMode', () => {
  it('reads the five facts', () => {
    const read = parseMode('r')
    expect(read.writable).toBe(false)
    expect(read.create).toBe(false)
    const update = parseMode('r+b')
    expect(update.writable).toBe(true)
    expect(update.truncate).toBe(false)
    expect(update.create).toBe(false)
    const write = parseMode('w')
    expect(write.writable && write.truncate && write.create).toBe(true)
    const append = parseMode('a')
    expect(append.append).toBe(true)
    expect(append.truncate).toBe(false)
    const exclusive = parseMode('x')
    expect(exclusive.exclusive && exclusive.create).toBe(true)
  })
})

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

describe('FileTable', () => {
  it('hands out dense ids from firstId', () => {
    const table = new FileTable<string>(4)
    expect(table.add('a')).toBe(4)
    expect(table.add('b')).toBe(5)
    expect(table.get(4)).toBe('a')
    expect(table.has(5)).toBe(true)
    expect(table.has(9)).toBe(false)
  })

  it('set and pop move entries without burning ids', () => {
    const table = new FileTable<string>()
    const fd = table.add('a')
    table.set(0, 'seeded')
    expect(table.pop(fd)).toBe('a')
    expect(table.pop(fd)).toBeUndefined()
    expect(table.get(0)).toBe('seeded')
    expect([...table.values()]).toEqual(['seeded'])
  })
})
