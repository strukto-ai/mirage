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

import { encodeText } from './bytes.ts'
import { decodeAnsiC } from './escapes.ts'

// Direct port of tests/shell/test_escapes.py. Expectations pinned
// against bash 5.2.37 in docker (debian:stable-slim, LC_ALL=C.UTF-8).

describe('decodeAnsiC', () => {
  it.each([
    ['a\\nb', 'a\nb'],
    ['\\a\\b\\f\\r\\t\\v', '\x07\b\f\r\t\v'],
    ['\\e\\E', '\x1b\x1b'],
    ['\\\\', '\\'],
    ['\\\'\\"\\?', '\'"?'],
    ['plain', 'plain'],
    ['', ''],
  ])('decodes simple escapes: %s', (content, expected) => {
    expect(decodeAnsiC(content)).toBe(expected)
  })

  it.each([
    ['\\x41', 'A'],
    ['\\x9', '\t'],
    ['\\x413', 'A3'],
    ['\\101', 'A'],
    ['\\1013', 'A3'],
    ['\\0101', '\b1'],
    ['\\u41', 'A'],
    ['中', '中'],
    ['\\U0001F600', '\u{1F600}'],
  ])('decodes numeric escapes: %s', (content, expected) => {
    expect(decodeAnsiC(content)).toBe(expected)
  })

  it.each([
    ['\\cA', '\x01'],
    ['\\cz', '\x1a'],
    ['\\c[', '\x1b'],
    ['\\c?', '\x7f'],
  ])('decodes control escapes: %s', (content, expected) => {
    expect(decodeAnsiC(content)).toBe(expected)
  })

  it('consumes an escaped backslash as one control operand', () => {
    // \c\\ is ctrl-backslash and both characters belong to the operand;
    // \c\n is ctrl-backslash followed by a literal n (bash 5.2).
    expect(decodeAnsiC('\\c\\\\')).toBe('\x1c')
    expect(decodeAnsiC('\\c\\n')).toBe('\x1cn')
  })

  it.each([['\\q'], ['\\x'], ['\\u'], ['\\U'], ['\\c'], ['\\8']])(
    'keeps unknown or incomplete escapes verbatim: %s',
    (content) => {
      expect(decodeAnsiC(content)).toBe(content)
    },
  )

  it('keeps a trailing backslash verbatim', () => {
    expect(decodeAnsiC('a\\')).toBe('a\\')
  })

  it('does not treat backslash-newline as a continuation', () => {
    expect(decodeAnsiC('\\\nx')).toBe('\\\nx')
  })

  it.each([['a\\0b'], ['a\\x00b'], ['a\\u0000b'], ['a\\c@b'], ['a\\400b']])(
    'truncates the segment at NUL: %s',
    (content) => {
      expect(decodeAnsiC(content)).toBe('a')
    },
  )

  it('carries high bytes through the surrogate escape', () => {
    expect(encodeText(decodeAnsiC('\\xff'))).toEqual(new Uint8Array([0xff]))
    expect(encodeText(decodeAnsiC('\\777'))).toEqual(new Uint8Array([0xff]))
    // Three hex byte escapes reassemble into one UTF-8 character.
    expect(encodeText(decodeAnsiC('\\xe4\\xb8\\xad'))).toEqual(new TextEncoder().encode('中'))
  })

  it('encodes surrogate halves like a UTF-8 locale', () => {
    // bash 5.2 (docker, LC_ALL=C.UTF-8 at startup) writes \u/\U through
    // u32toutf8, so a surrogate half comes out as its raw three-byte
    // form; U+E000, one past the range, is an ordinary character.
    expect(encodeText(decodeAnsiC('\\uD800'))).toEqual(new Uint8Array([0xed, 0xa0, 0x80]))
    expect(encodeText(decodeAnsiC('\\udbff'))).toEqual(new Uint8Array([0xed, 0xaf, 0xbf]))
    expect(encodeText(decodeAnsiC('\\U0000DFFF'))).toEqual(new Uint8Array([0xed, 0xbf, 0xbf]))
    expect(decodeAnsiC('\\ue000')).toBe('\ue000')
  })

  it('encodes values past Unicode or drops them at 0x80000000', () => {
    // u32toutf8 keeps the old-style four- to six-byte forms alive past
    // Unicode, and 0x80000000 and past produce nothing - without
    // truncating the rest of the segment the way NUL does.
    expect(encodeText(decodeAnsiC('\\U00110000'))).toEqual(new Uint8Array([0xf4, 0x90, 0x80, 0x80]))
    expect(encodeText(decodeAnsiC('\\U7FFFFFFF'))).toEqual(
      new Uint8Array([0xfd, 0xbf, 0xbf, 0xbf, 0xbf, 0xbf]),
    )
    expect(decodeAnsiC('x\\UFFFFFFFFy')).toBe('xy')
    expect(decodeAnsiC('x\\U80000000y')).toBe('xy')
  })
})
