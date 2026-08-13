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
import { parseMode } from './mode.ts'

describe('parseMode', () => {
  it('reads the facts', () => {
    const read = parseMode('r')
    expect(read.writable).toBe(false)
    expect(read.create).toBe(false)
    expect(read.readable).toBe(true)
    expect(read.binary).toBe(false)
    const update = parseMode('r+b')
    expect(update.writable).toBe(true)
    expect(update.truncate).toBe(false)
    expect(update.create).toBe(false)
    expect(update.readable).toBe(true)
    expect(update.binary).toBe(true)
    const write = parseMode('w')
    expect(write.writable && write.truncate && write.create).toBe(true)
    expect(write.readable).toBe(false)
    const append = parseMode('a')
    expect(append.append).toBe(true)
    expect(append.truncate).toBe(false)
    const exclusive = parseMode('x')
    expect(exclusive.exclusive && exclusive.create).toBe(true)
    expect(exclusive.readable).toBe(false)
  })

  it('makes every base readable and writable under +', () => {
    for (const spelling of ['r+', 'w+', 'a+', 'x+']) {
      const mode = parseMode(spelling)
      expect(mode.readable, spelling).toBe(true)
      expect(mode.writable, spelling).toBe(true)
    }
  })

  it("reads 'wx' as C fopen's exclusive create", () => {
    // CPython spells exclusive creation as a bare 'x'; C fopen (and
    // so qjs-wasi's std.open) spells it 'wx'. One parser serves both
    // dialects, so both spellings answer the same facts.
    const mode = parseMode('wx')
    expect(mode.exclusive && mode.create && mode.truncate).toBe(true)
    expect(mode.writable).toBe(true)
    expect(mode.readable).toBe(false)
  })

  it('refuses garbage modes in CPython wording', () => {
    // One parser, the stricter half's rule: exactly one of rwax, at
    // most one each of +, b, t, and never b with t.
    for (const bad of ['', 'q', 'rw', 'rr', 'r++', 'rbb', 'rbt', 'wq', 'b']) {
      expect(() => parseMode(bad), bad).toThrow(/invalid mode/)
    }
  })

  it('accepts the text flag and reads it as not binary', () => {
    const mode = parseMode('rt')
    expect(mode.binary).toBe(false)
    expect(mode.readable).toBe(true)
  })
})
