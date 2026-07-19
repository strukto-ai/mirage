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
import { fnmatch } from './fnmatch.ts'

const NAMES = [
  '',
  'a',
  'b',
  'd',
  '!',
  '-',
  '^',
  'ab',
  'xx',
  'z',
  'a.txt',
  'A.TXT',
  'a.txt.bak',
  '.hidden',
  'a/b',
  'a\nb',
  '[abc]',
  'a{2}',
  'x+y',
  '[',
  '[ab',
  'file5',
  'fileX',
  'a-b',
  'axb',
  ']',
]

// Generated against CPython fnmatch.fnmatchcase. Regenerate by running each
// pattern through python3: [n for n in NAMES if fnmatch.fnmatchcase(n, pattern)]
// Deliberate divergence from CPython: a leading ^ negates a class like !
// does (bash/glibc semantics), so [^abc] rows differ from fnmatchcase.
const GOLDEN: [string, string[]][] = [
  ['*', NAMES],
  ['?', ['a', 'b', 'd', '!', '-', '^', 'z', '[', ']']],
  ['', ['']],
  ['a.txt', ['a.txt']],
  ['*.txt', ['a.txt']],
  ['a?txt*', ['a.txt', 'a.txt.bak']],
  ['a*b', ['ab', 'a/b', 'a\nb', 'a-b', 'axb']],
  ['**', NAMES],
  ['[abc]', ['a', 'b']],
  ['[!abc]', ['d', '!', '-', '^', 'z', '[', ']']],
  ['[a-z]', ['a', 'b', 'd', 'z']],
  ['[!a-z]', ['!', '-', '^', '[', ']']],
  ['[a-]', ['a', '-']],
  ['[-a]', ['a', '-']],
  ['[]a]', ['a', ']']],
  ['[!]a]', ['b', 'd', '!', '-', '^', 'z', '[']],
  ['[z-a]', []],
  ['[', ['[']],
  ['[ab', ['[ab']],
  ['a[xy]b', ['axb']],
  ['a{2}', ['a{2}']],
  ['x+y', ['x+y']],
  ['[^abc]', ['d', '!', '-', '^', 'z', '[', ']']],
  ['[[]', ['[']],
  ['file[0-9]', ['file5']],
  ['*[5X]', ['file5', 'fileX']],
]

describe('fnmatch matches CPython fnmatch.fnmatchcase', () => {
  for (const [pattern, hits] of GOLDEN) {
    it(`pattern ${JSON.stringify(pattern)}`, () => {
      const expected = new Set(hits)
      for (const name of NAMES) expect(fnmatch(name, pattern)).toBe(expected.has(name))
    })
  }
})

describe('fnmatch edge semantics', () => {
  it('* crosses / and newline like Python (no path-awareness)', () => {
    expect(fnmatch('a/b', '*')).toBe(true)
    expect(fnmatch('a\nb', 'a*b')).toBe(true)
  })

  it('invalid range [z-a] never matches and never throws', () => {
    expect(fnmatch('z', '[z-a]')).toBe(false)
    expect(fnmatch('-', '[z-a]')).toBe(false)
  })

  it('lone [ is a literal', () => {
    expect(fnmatch('[ab', '[ab')).toBe(true)
    expect(fnmatch('a', '[ab')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(fnmatch('A.TXT', '*.txt')).toBe(false)
    expect(fnmatch('a.txt', '*.txt')).toBe(true)
  })

  it('leading ^ negates a class like ! (bash/glibc semantics)', () => {
    expect(fnmatch('c.txt', '[^ab].txt')).toBe(true)
    expect(fnmatch('a.txt', '[^ab].txt')).toBe(false)
    expect(fnmatch('^', '[a^]')).toBe(true)
    expect(fnmatch('b', '[a^]')).toBe(false)
  })
})
