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
import { interpretEscapes } from './escapes.ts'

// Every case pinned against GNU coreutils 9.7 (debian:stable-slim). Mirrors
// python/tests/commands/builtin/utils/test_escapes.py case for case.
describe('interpretEscapes (tr SET grammar)', () => {
  it.each([
    ['\\n', '\n'],
    ['\\t', '\t'],
    ['\\r', '\r'],
    ['\\a', '\x07'],
    ['\\b', '\b'],
    ['\\f', '\f'],
    ['\\v', '\v'],
    ['a\\\\b', 'a\\b'],
  ])('resolves the named escape %j', (input, expected) => {
    expect(interpretEscapes(input)).toBe(expected)
  })

  it('reads \\0 as NUL', () => {
    expect(interpretEscapes('\\0')).toBe('\0')
  })

  it('reads octal with no leading zero, unlike echo', () => {
    // `printf abc | tr '\141' X` => Xbc
    expect(interpretEscapes('\\141')).toBe('a')
  })

  it('stops octal at three digits', () => {
    // `printf abc | tr '\0141' X` => abc: the set is {FF, '1'}, neither
    // of which appears in the input.
    expect(interpretEscapes('\\0141')).toBe('\f1')
  })

  it('stops octal at the first non-octal digit', () => {
    // `printf a9b | tr '\19' Z` => aZb: the set is {SOH, '9'}.
    expect(interpretEscapes('\\19')).toBe('\x019')
  })

  it('backs off an out-of-range three-digit octal to two digits', () => {
    // GNU warns "the ambiguous octal escape \400 is being interpreted as
    // the 2-byte sequence \040, 0" and yields {space, '0'}; we make the
    // same substitution without the warning, which has no channel here.
    expect(interpretEscapes('\\400')).toBe(' 0')
  })

  it.each([
    ['\\z', 'z'],
    ['\\e', 'e'],
    ['\\8', '8'],
    ['\\9', '9'],
  ])('drops the backslash on the unknown escape %j', (input, expected) => {
    expect(interpretEscapes(input)).toBe(expected)
  })

  it('has no \\xHH — that is echo only', () => {
    // `printf axb | tr '\x41' -` => a-b, i.e. the set is {x, 4, 1}.
    expect(interpretEscapes('\\x41')).toBe('x41')
  })

  it('has no \\c — that is echo only', () => {
    expect(interpretEscapes('hello\\cworld')).toBe('hellocworld')
  })

  it('keeps a trailing backslash literal', () => {
    expect(interpretEscapes('end\\')).toBe('end\\')
  })

  it.each([
    ['', ''],
    ['hello world', 'hello world'],
    ['a-z', 'a-z'],
  ])('leaves %j alone', (input, expected) => {
    expect(interpretEscapes(input)).toBe(expected)
  })

  it('resolves escapes inside a range so expandRanges sees the endpoints', () => {
    expect(interpretEscapes('\\101-\\103')).toBe('A-C')
  })
})
