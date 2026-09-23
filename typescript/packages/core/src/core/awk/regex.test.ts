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
import { AwkSyntaxError } from './errors.ts'
import { compileEre, matches, searchFrom, splitPattern } from './regex.ts'

describe('awk regex', () => {
  it.each([
    ['[[:digit:]]+', 'abc 123', true],
    ['^[[:upper:]]', 'hello', false],
    ['[[:space:]]$', 'trail ', true],
    ['^[]a]+$', ']a', true],
    ['[^a-c]', 'abc', false],
    ['a{2}', 'aab', true],
    ['(ab|cd)+$', 'abcd', true],
    ['\\.', 'a.c', true],
    ['\\.', 'abc', false],
    ['a.c', 'a\nc', true],
    ['b$', 'ab\n', false],
    ['\\<the\\>', 'in the end', true],
    ['\\<he\\>', 'in the end', false],
    ['\\$', 'cost $5', true],
  ])('matches(%j, %j) is %j', (pattern, subject, expected) => {
    expect(matches(pattern, subject)).toBe(expected)
  })

  it.each(['[', '[[:bogus:]]', 'a(b', '*a**'])('gives %j the one wording', (pattern) => {
    expect(() => compileEre(pattern)).toThrow(AwkSyntaxError)
    expect(() => compileEre(pattern)).toThrow(
      `awk: syntax error in regular expression ${pattern} at source line 1`,
    )
  })

  it('builds the field-splitting pattern', () => {
    expect(splitPattern(' ')).toBeNull()
    const single = splitPattern('|')
    expect(single && searchFrom(single, 'a|b', 0)).not.toBeNull()
    expect(single && searchFrom(single, 'ab', 0)).toBeNull()
    const dot = splitPattern('.')
    expect(dot && searchFrom(dot, 'ab', 0)).toBeNull()
    const multi = splitPattern('[,;]+')
    expect(multi && searchFrom(multi, 'a,;b', 0)).not.toBeNull()
  })
})
