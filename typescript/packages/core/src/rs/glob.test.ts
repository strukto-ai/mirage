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
import { Glob, GlobMatcher, anyTailMatcher, globMatcher } from './glob.ts'

it('feeds a long subject in pieces without splitting a surrogate pair', async () => {
  const glob = new Glob('*😀b')
  try {
    expect(await glob.matchesAsync('a'.repeat(4095) + '😀b')).toBe(true)
  } finally {
    glob.close()
  }
})

describe('GlobMatcher', () => {
  it.each([
    ['?.txt', '😀.txt', true],
    ['*\udcff', 'a'.repeat(30_000) + '\udcff', true],
    ['*b', 'a'.repeat(30_000) + '\udcff', false],
    ['\udcff\ud83d', '\udcff\ud83d', true],
  ])('counts characters and keeps lone surrogates against %j', (pattern, name, expected) => {
    expect(new GlobMatcher(pattern).matches(name)).toBe(expected)
  })

  it.each([
    ['a.com', 'a.co', false],
    ['[a', '[a', true],
    ['\u{fdd0}', '*', true],
    ['\u{fdd0}', 'a', false],
  ])('matches a plain pattern %j against its own text alone', (pattern, name, expected) => {
    expect(new GlobMatcher(pattern).matches(name)).toBe(expected)
  })

  it('shares one matcher per pattern and kind', () => {
    expect(globMatcher('a*')).toBe(globMatcher('a*'))
    expect(globMatcher('a*', true)).not.toBe(globMatcher('a*'))
    expect(globMatcher('a*', false, false, 'python')).not.toBe(globMatcher('a*'))
  })
})

describe('anyTailMatcher', () => {
  it.each<[readonly string[], string, boolean]>([
    [['b.log'], 'b.log', true],
    [['b.log'], 'a/b.log', true],
    [['a/b*'], 'x/a/b.log', true],
    [['*.log'], 'a/b.log', true],
    [['c*'], 'a/bc', false],
    [['a'], 'a/b', false],
    [['*.txt', 'b*'], 'a/b.log', true],
    [[], 'a/b.log', false],
  ])('answers %j for the name or a part after a slash of %j', (patterns, shown, expected) => {
    expect(anyTailMatcher(patterns).matches(shown)).toBe(expected)
  })

  it('is shared by callers holding the same list', () => {
    const patterns = ['a', 'b']
    expect(anyTailMatcher(patterns)).toBe(anyTailMatcher(patterns))
    expect(anyTailMatcher(patterns)).not.toBe(anyTailMatcher(['a', 'b']))
  })
})
