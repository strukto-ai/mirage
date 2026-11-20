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
import { rstripChars, rstripNewlines } from './text.ts'

describe('rstripNewlines', () => {
  const SAMPLES = ['', 'a', 'a\n', 'a\n\n\n', '\n\n', 'a\nb\n', 'line1\nline2', '\n\na\n']

  it('matches .replace(/\\n+$/, "") for representative inputs', () => {
    for (const s of SAMPLES) expect(rstripNewlines(s)).toBe(s.replace(/\n+$/, ''))
  })

  it('only strips trailing newlines, not interior or other whitespace', () => {
    expect(rstripNewlines('a\nb\n\n')).toBe('a\nb')
    expect(rstripNewlines('a \n')).toBe('a ')
    expect(rstripNewlines('a\t')).toBe('a\t')
  })
})

describe('rstripChars', () => {
  it('strips any trailing run of the given characters', () => {
    expect(rstripChars('a\\b//\\', '\\/')).toBe('a\\b')
    expect(rstripChars('XaXXX', 'X')).toBe('Xa')
    expect(rstripChars('v1.-.', '.-')).toBe('v1')
    expect(rstripChars('===', '=')).toBe('')
    expect(rstripChars('ab', 'c')).toBe('ab')
    expect(rstripChars('x\u{1F200}', '\u{1F600}')).toBe('x\u{1F200}')
    expect(rstripChars('a\u{1F600}\u{1F600}', '\u{1F600}')).toBe('a')
  })
})
