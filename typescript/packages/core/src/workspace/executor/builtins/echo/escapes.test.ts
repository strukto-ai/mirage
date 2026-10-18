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
import { encodeText } from '../../../../shell/bytes.ts'
import { interpretEscapes } from './escapes.ts'

describe('interpretEscapes (port of tests/workspace/executor/test_escapes.py)', () => {
  it('newline', () => {
    expect(interpretEscapes('a\\nb')).toEqual(['a\nb', false])
  })

  it('tab', () => {
    expect(interpretEscapes('a\\tb')).toEqual(['a\tb', false])
  })

  it('carriage return', () => {
    expect(interpretEscapes('\\r')).toEqual(['\r', false])
  })

  it('bell', () => {
    expect(interpretEscapes('\\a')).toEqual(['\x07', false])
  })

  it('backspace', () => {
    expect(interpretEscapes('\\b')).toEqual(['\b', false])
  })

  it('form feed', () => {
    expect(interpretEscapes('\\f')).toEqual(['\f', false])
  })

  it('vertical tab', () => {
    expect(interpretEscapes('\\v')).toEqual(['\v', false])
  })

  it('backslash', () => {
    expect(interpretEscapes('a\\\\b')).toEqual(['a\\b', false])
  })

  it('escaped backslash does not re-escape the next character', () => {
    expect(interpretEscapes('\\\\n')).toEqual(['\\n', false])
  })

  it('hex escape', () => {
    expect(interpretEscapes('\\x41')).toEqual(['A', false])
  })

  it('short hex escape', () => {
    expect(interpretEscapes('\\x9')).toEqual(['\t', false])
  })

  it('bare \\x is literal', () => {
    expect(interpretEscapes('\\x')).toEqual(['\\x', false])
  })

  it('octal escape', () => {
    expect(interpretEscapes('\\0101')).toEqual(['A', false])
  })

  it('bare \\0 is NUL', () => {
    expect(interpretEscapes('\\0')).toEqual(['\0', false])
  })

  it('\\c stops output', () => {
    expect(interpretEscapes('hello\\cworld')).toEqual(['hello', true])
  })

  it('unknown escape passes through with its backslash', () => {
    expect(interpretEscapes('\\z')).toEqual(['\\z', false])
  })

  it('plain text', () => {
    expect(interpretEscapes('hello world')).toEqual(['hello world', false])
  })

  it('empty', () => {
    expect(interpretEscapes('')).toEqual(['', false])
  })

  it('trailing backslash', () => {
    expect(interpretEscapes('end\\')).toEqual(['end\\', false])
  })

  it('mixed', () => {
    expect(interpretEscapes('a\\tb\\nc\\\\d')).toEqual(['a\tb\nc\\d', false])
  })

  // Pinned against bash 5.2.37 in docker (debian:stable-slim,
  // LC_ALL=C.UTF-8): echo -e '<text>' | od -An -tx1.

  it('\\e and \\E are ESC', () => {
    expect(interpretEscapes('a\\eb\\Ec')).toEqual(['a\x1bb\x1bc', false])
  })

  it('ESC at the end of the text', () => {
    expect(interpretEscapes('a\\e')).toEqual(['a\x1b', false])
    expect(interpretEscapes('a\\E')).toEqual(['a\x1b', false])
  })

  it('ESC before \\c', () => {
    expect(interpretEscapes('a\\E\\cb')).toEqual(['a\x1b', true])
    expect(interpretEscapes('a\\E\\c')).toEqual(['a\x1b', true])
  })

  it('\\c before ESC', () => {
    expect(interpretEscapes('a\\c\\Eb')).toEqual(['a', true])
  })

  it('escaped backslash before e', () => {
    expect(interpretEscapes('\\\\e\\\\E')).toEqual(['\\e\\E', false])
  })

  it('\\u and \\U name a code point', () => {
    expect(interpretEscapes('\\u00e9')).toEqual(['é', false])
    expect(interpretEscapes('\\U0001F600')).toEqual(['\u{1F600}', false])
  })

  it('\\u and \\U read at most their digits', () => {
    expect(interpretEscapes('\\u0041B')).toEqual(['AB', false])
    expect(interpretEscapes('\\u41')).toEqual(['A', false])
    expect(interpretEscapes('\\U41')).toEqual(['A', false])
  })

  it('\\u and \\U without digits are literal', () => {
    expect(interpretEscapes('\\u')).toEqual(['\\u', false])
    expect(interpretEscapes('\\ug')).toEqual(['\\ug', false])
    expect(interpretEscapes('\\U')).toEqual(['\\U', false])
  })

  it('a \\u NUL is written', () => {
    expect(interpretEscapes('a\\u0000b')).toEqual(['a\0b', false])
  })

  it('\\u and \\U outside Unicode are UTF-8-shaped', () => {
    expect([...encodeText(interpretEscapes('\\uD800')[0])]).toEqual([0xed, 0xa0, 0x80])
    expect([...encodeText(interpretEscapes('\\U00110000')[0])]).toEqual([0xf4, 0x90, 0x80, 0x80])
    expect(interpretEscapes('\\UFFFFFFFF')).toEqual(['', false])
  })
})
