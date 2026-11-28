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
import {
  jsText,
  jsTrim,
  jsonText,
  memberText,
  pagesText,
  plain,
  sanitizeControl,
  snippet,
  truthy,
  utf16Length,
  utf16Slice,
} from './render.ts'

// Mirrors python's tests/commands/cli/builtin/tvly/test_render.py, whose
// helpers emulate what these read off JavaScript itself.
describe('tvly rendering', () => {
  it.each([
    [null, 'null'],
    [true, 'true'],
    [1.0, '1'],
    [0.5, '0.5'],
    [[1, null, 'a'], '1,,a'],
    [{ a: 1 }, '[object Object]'],
  ])("spells %j as JavaScript's String spells it", (value, text) => {
    expect(jsText(value)).toBe(text)
  })

  it('reads an empty container as true and an empty string as false', () => {
    expect(truthy([]) && truthy({})).toBe(true)
    expect(truthy('') || truthy(0) || truthy(null)).toBe(false)
  })

  it("trims JavaScript's whitespace set", () => {
    expect(jsTrim('﻿  a 　')).toBe('a')
    expect(jsTrim('\x1c a')).toBe('\x1c a')
    expect(jsTrim(` a${' '.repeat(200_000)}b\ufeff`)).toBe(`a${' '.repeat(200_000)}b`)
  })

  it('counts and cuts in UTF-16 units', () => {
    expect(utf16Length('a😀')).toBe(3)
    // A cut through a pair keeps its lone high half, which the encoder
    // writes as U+FFFD: the bytes python's twin prints.
    const enc = new TextEncoder()
    expect(enc.encode(utf16Slice('a😀b', 2))).toEqual(enc.encode('a�'))
    expect(utf16Slice('a😀b', 3)).toBe('a😀')
  })

  it('drops controls but tab, newline and return', () => {
    expect(sanitizeControl('a\x00b\x1b[31mc\x85d\te\n')).toBe('ab[31mcd\te\n')
  })

  it("folds blank runs and trims, keeping the next line's indent", () => {
    expect(plain('  one\n\n\n \n two  ')).toBe('one\n\n two')
  })

  it('joins whitespace and cuts with an ellipsis in a snippet', () => {
    expect(snippet('a  b\n\tc', 0)).toBe('a b c')
    expect(snippet('abcdef', 3)).toBe('abc...')
    expect(snippet('abc', 3)).toBe('abc')
  })

  it('reads a missing member as undefined and a null one as null', () => {
    expect(memberText({ url: null }, 'url')).toBe('null')
    expect(memberText({}, 'url')).toBe('undefined')
  })

  it('spells numbers as JSON.stringify does', () => {
    expect(jsonText({ a: 1.0, b: [0.1] }, false)).toBe('{"a":1,"b":[0.1]}')
    expect(jsonText({ a: [] }, true)).toBe('{\n  "a": []\n}')
  })

  it('echoes each page under its url', () => {
    const pages = [{ url: 'https://a', raw_content: 'body' }, { url: 'https://b' }]
    expect(pagesText(pages)).toBe('# https://a\n\nbody\n\n# https://b\n\n(no content)\n\n')
  })
})
