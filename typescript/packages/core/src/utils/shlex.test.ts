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
import { shlexSplit } from './shlex.ts'

describe('shlexSplit', () => {
  it('splits whitespace-separated words', () => {
    expect(shlexSplit('a b c')).toEqual(['a', 'b', 'c'])
  })

  it('backslash escapes the next char', () => {
    expect(shlexSplit('hello\\ world')).toEqual(['hello world'])
  })

  it('single quotes preserve everything', () => {
    expect(shlexSplit("'a b'")).toEqual(['a b'])
  })

  it('double quotes support escape sequences', () => {
    expect(shlexSplit('"a\\"b"')).toEqual(['a"b'])
  })

  it('throws on unterminated quote', () => {
    expect(() => shlexSplit("'open")).toThrow('unterminated quote')
  })
})
