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
import { openMode, parseMode } from './mode.ts'

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

  it('refuses garbage modes in CPython wording', () => {
    // CPython's rule: exactly one of rwax, at most one each of +, b, t,
    // and never b with t.
    const plusOne = 'Must have exactly one of create/read/write/append mode and at most one plus'
    const refusals: [string, string][] = [
      ['', plusOne],
      ['+', plusOne],
      ['b', plusOne],
      ['q', "invalid mode: 'q'"],
      ['rr', "invalid mode: 'rr'"],
      ['r++', "invalid mode: 'r++'"],
      ['btq', "invalid mode: 'btq'"],
      ['rbt', "can't have text and binary mode at once"],
      ['rw', 'must have exactly one of create/read/write/append mode'],
      ['wx', 'must have exactly one of create/read/write/append mode'],
    ]
    for (const [bad, message] of refusals) expect(() => parseMode(bad), bad).toThrow(message)
  })

  it('accepts the text flag and reads it as not binary', () => {
    const mode = parseMode('rt')
    expect(mode.binary).toBe(false)
    expect(mode.readable).toBe(true)
  })
})

describe('openMode', () => {
  // The host's own flag numbers, as Emscripten numbers them.
  const bits = { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024 }

  it('reads the access bits and what the open does', () => {
    const read = openMode(0, bits)
    expect([read.readable, read.writable]).toEqual([true, false])
    const write = openMode(bits.O_WRONLY | bits.O_CREAT | bits.O_TRUNC, bits)
    expect([write.readable, write.writable, write.create, write.truncate]).toEqual([
      false,
      true,
      true,
      true,
    ])
    const both = openMode(bits.O_RDWR | bits.O_APPEND, bits)
    expect([both.readable, both.writable, both.append, both.truncate]).toEqual([
      true,
      true,
      true,
      false,
    ])
  })
})
