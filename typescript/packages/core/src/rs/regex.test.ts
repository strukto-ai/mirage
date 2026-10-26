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
import { RegexError } from './errors.ts'
import { LineRegex, PosixRegex, posixEscape, posixRegex } from './regex.ts'

// Backtracking through every way to split the a's before refusing the b:
// millions of steps, so the search pauses and the loop runs between.
const LONG_PATTERN = '^\\(a\\|aa\\)*\\1c$'
const LONG_SUBJECT = 'a'.repeat(26) + 'b'

async function texts(regex: PosixRegex, subject: string): Promise<(string | null)[]> {
  const found = await regex.search(subject)
  expect(found).not.toBeNull()
  return (found ?? []).map((span) => (span === null ? null : subject.slice(span[0], span[1])))
}

describe('PosixRegex', () => {
  it.each([
    ['(a|ab)(bc|c)', 'abc', ['abc', 'a', 'bc']],
    ['(ab|a)(bc|c)', 'abc', ['abc', 'ab', 'c']],
    ['(a|ab)*', 'abab', ['abab', 'ab']],
    ['(a*)(ab)*(b*)', 'aabab', ['aabab', 'a', 'ab', '']],
    ['(a*)+', 'aa', ['aa', 'aa']],
    ['(a?)*', 'aa', ['aa', 'a']],
    ['((a)|b)*', 'ab', ['ab', 'b', 'a']],
  ])('places the groups of %s on %s as glibc does', async (pattern, subject, want) => {
    expect(await texts(new PosixRegex(pattern, true, 'sed'), subject)).toEqual(want)
  })

  it('counts offsets in characters of the view', async () => {
    expect(await new PosixRegex('é.', false, 'posix', false, true).search('aéb')).toEqual([[1, 3]])
    expect(await new PosixRegex('😀.', false, 'posix', false, true).search('a😀b')).toEqual([
      [1, 4],
    ])
    expect(await new PosixRegex('\\(.\\)').search('\xc3\xa9')).toEqual([
      [0, 1],
      [0, 1],
    ])
  })

  it('passes over an empty match where one ended in a global walk', async () => {
    const found = await new PosixRegex('a*', false, 'sed').all('baaac')
    expect(found.map((spans) => spans[0])).toEqual([
      [0, 0],
      [1, 4],
      [5, 5],
    ])
  })

  it.each([
    ['a**', false, 'sed'],
    ['*a', true, 'sed'],
    ['\\{1\\}', false, 'sed'],
    ['*a', true, 'posix'],
  ] as const)('refuses %s by its dialect', (pattern, extended, dialect) => {
    expect(() => new PosixRegex(pattern, extended, dialect)).toThrow(
      new RegexError('Invalid preceding regular expression'),
    )
  })

  it("takes in regcomp's basic syntax what sed refuses", async () => {
    expect(await new PosixRegex('a**').search('aa')).toEqual([[0, 2]])
    expect(await new PosixRegex('[z-a]x').search('x')).toBeNull()
    expect(() => new PosixRegex('[z-a]', false, 'sed')).toThrow('Invalid range end')
  })

  it('reads the newlines a match consumes at its anchors', async () => {
    expect(await new PosixRegex('a.^b', true, 'sed').search('a\nb')).toEqual([[0, 3]])
    expect(await new PosixRegex('^b', false, 'sed').search('a\nb')).toBeNull()
    expect(await new PosixRegex('b$.', true, 'sed').search('b\nc')).toEqual([[0, 2]])
    expect(await new PosixRegex('(b)$.', true, 'sed').search('b\nc')).toBeNull()
    expect(await new PosixRegex('^b', false, 'sed', false, false, true).search('a\nb')).toEqual([
      [2, 3],
    ])
  })

  it('skips NUL at a dot for regcomp only', async () => {
    expect(await new PosixRegex('a.b').search('a\0b')).toBeNull()
    expect(await new PosixRegex('a[^x]b').search('a\0b')).toEqual([[0, 3]])
    expect(await new PosixRegex('a.b', false, 'sed').search('a\0b')).toEqual([[0, 3]])
  })

  it('reads classes and case by Unicode under UTF-8', async () => {
    expect(await new PosixRegex('[[:alpha:]]', false, 'posix', false, true).search('-é')).toEqual([
      [1, 2],
    ])
    expect(await new PosixRegex('é', false, 'posix', true, true).search('É')).not.toBeNull()
    expect(await new PosixRegex('[[:alpha:]]').search('\xc3\xa9')).toBeNull()
  })

  it('never finds a raw byte inside a character', async () => {
    const regex = new PosixRegex('\udca9', false, 'posix', false, true)
    expect(await regex.search('é')).toBeNull()
    expect(await regex.search('a\udca9')).toEqual([[1, 2]])
  })

  it('wraps the match in word edges', async () => {
    const regex = new PosixRegex('ab|abc', true, 'posix', false, false, false, true)
    expect(await regex.search('abcd abc')).toEqual([[5, 8]])
  })

  it('escapes a literal to match only itself', async () => {
    const text = 'a.b*c[d]^$\\(e)'
    expect(await new PosixRegex(posixEscape(text), true).search('x' + text)).toEqual([
      [1, 1 + text.length],
    ])
  })
})

describe('a long search', () => {
  it('lets the loop run between its steps', async () => {
    let ticks = 0
    const done = new AbortController()
    const ticker = (async () => {
      while (!done.signal.aborted) {
        ticks += 1
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    })()
    try {
      expect(await new PosixRegex(LONG_PATTERN).matches(LONG_SUBJECT)).toBe(false)
    } finally {
      done.abort()
      await ticker
    }
    expect(ticks).toBeGreaterThan(1)
  })

  it('keeps the searches of tasks sharing one expression apart', async () => {
    const regex = posixRegex(LONG_PATTERN)
    const found = await Promise.all([
      regex.matches(LONG_SUBJECT),
      regex.search('a'.repeat(26) + 'c'),
      regex.matches('aac'),
    ])
    expect(found).toEqual([
      false,
      [
        [0, 27],
        [24, 25],
      ],
      true,
    ])
  })

  it('stops at an abort and leaves the expression usable', async () => {
    const regex = new PosixRegex(LONG_PATTERN)
    const signal = AbortSignal.timeout(1)
    await expect(regex.matches('a'.repeat(40) + 'b', signal)).rejects.toThrow()
    expect(await regex.matches('aac')).toBe(true)
  })
})

describe('LineRegex', () => {
  it('selects and extends lines as grep does', async () => {
    const regex = new LineRegex(['ab|abcd', 'x'], 'extended', false, false, true)
    expect(await regex.matches('abcd y')).toBe(true)
    expect(await regex.matches('abcde')).toBe(false)
    expect(await regex.extents('abcd x')).toEqual([
      [0, 4],
      [5, 6],
    ])
    expect(regex.needles).toEqual(['ab', 'abcd', 'x'])
  })

  it("carries grep's warnings and refusals", () => {
    expect(new LineRegex(['*a'], 'extended').warnings).toEqual(['* at start of expression'])
    expect(() => new LineRegex(['\\(a'], 'basic')).toThrow('Unmatched ( or \\(')
  })

  it('drops the needles Unicode folding could miss', () => {
    expect(new LineRegex(['kelvin'], 'fixed', true, true).needles).toBeNull()
    expect(new LineRegex(['KELVIN'], 'fixed', true).needles).toEqual(['kelvin'])
  })
})
