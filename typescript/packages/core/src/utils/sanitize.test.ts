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
  byteLength,
  ESCAPE_LEAD,
  isBlank,
  NAME_MAX_BYTES,
  pathSafeName,
  SAFE_SLASH,
  sanitizeLabel,
  sanitizeName,
  truncateBytes,
} from './sanitize.ts'

describe('sanitizeName', () => {
  it('returns "unknown" for empty/whitespace input', () => {
    expect(sanitizeName('')).toBe('unknown')
    expect(sanitizeName('   ')).toBe('unknown')
  })

  it('replaces unsafe chars with underscore', () => {
    expect(sanitizeName("alice's-channel")).toBe('alice_s-channel')
    expect(sanitizeName('hello#world')).toBe('hello_world')
  })

  it('replaces spaces with underscore', () => {
    expect(sanitizeName('hello world')).toBe('hello_world')
  })

  it('collapses multiple underscores', () => {
    expect(sanitizeName("a''b")).toBe('a_b')
  })

  it('strips leading/trailing underscores', () => {
    expect(sanitizeName('__hello__')).toBe('hello')
  })

  it('truncates to 100 chars', () => {
    const long = 'x'.repeat(150)
    expect(sanitizeName(long)).toBe('x'.repeat(100))
  })

  it('preserves dots and hyphens', () => {
    expect(sanitizeName('foo.bar-baz')).toBe('foo.bar-baz')
  })

  it('preserves unicode letters like python \\w', () => {
    expect(sanitizeName('日本語 docs')).toBe('日本語_docs')
  })

  // Every hierarchy classifier treats a dot-led segment as hidden, so a label
  // that rendered one was dropped from its listing and refused as a path; an
  // empty one rendered `__<id>`, which no `label__id` slot decodes.
  it('is never dot-led or empty', () => {
    const cases: [string, string][] = [
      ['.plan', 'plan'],
      ['..', 'unknown'],
      ['.', 'unknown'],
      ['_.env', 'env'],
      [' .x', 'x'],
      ['..x..', 'x..'],
      ['!!!', 'unknown'],
      ['🚀🚀', 'unknown'],
      ['a.b.', 'a.b.'],
    ]
    for (const [raw, name] of cases) expect(sanitizeName(raw), raw).toBe(name)
  })
})

describe('pathSafeName', () => {
  it('returns "unknown" for empty/whitespace input', () => {
    expect(pathSafeName('')).toBe('unknown')
    expect(pathSafeName('   ')).toBe('unknown')
  })

  it('preserves spelling and replaces only the path separator', () => {
    expect(pathSafeName("Zecheng's Server")).toBe("Zecheng's Server")
    expect(pathSafeName('a/b')).toBe('a∕b')
  })
})

describe('sanitizeLabel', () => {
  it('replaces unsafe characters and spaces with underscores', () => {
    expect(sanitizeLabel('Hello World', { fallback: 'X', maxLen: 100 })).toBe('Hello_World')
    expect(sanitizeLabel('My/Doc: A\\Test', { fallback: 'X', maxLen: 100 })).toBe('My_Doc_A_Test')
  })

  it('collapses runs and trims the edges', () => {
    expect(sanitizeLabel('Hello   //  World', { fallback: 'X', maxLen: 100 })).toBe('Hello_World')
    expect(sanitizeLabel('__edge__', { fallback: 'X', maxLen: 100 })).toBe('edge')
  })

  it('is never dot-led or empty', () => {
    const cases: [string, string][] = [
      ['.plan', 'plan'],
      ['...', 'No_Subject'],
      ['!!!', 'No_Subject'],
      ['_.x', 'x'],
    ]
    for (const [raw, label] of cases) {
      expect(sanitizeLabel(raw, { fallback: 'No_Subject', maxLen: 80 }), raw).toBe(label)
    }
  })

  it('uses the fallback for a blank label', () => {
    expect(sanitizeLabel('', { fallback: 'Untitled', maxLen: 100 })).toBe('Untitled')
    expect(sanitizeLabel('   ', { fallback: 'No_Subject', maxLen: 80 })).toBe('No_Subject')
  })

  it('ellipsizes past the budget', () => {
    const long = sanitizeLabel('x'.repeat(120), { fallback: 'X', maxLen: 100 })
    expect(long).toHaveLength(100)
    expect(long.endsWith('...')).toBe(true)
    expect(sanitizeLabel('x'.repeat(100), { fallback: 'X', maxLen: 100 })).toBe('x'.repeat(100))
  })

  it('measures the budget in code points, matching python', () => {
    // `String.length` counts UTF-16 units, so 50 ascii plus 26 astral letters
    // reads as 102 there and 76 in python. Measuring in units truncated a
    // label python leaves whole, and sliced through a surrogate pair.
    const label = 'a'.repeat(50) + '\u{10400}'.repeat(26)
    const out = sanitizeLabel(label, { fallback: 'X', maxLen: 100 })
    expect(out).toBe(label)
    expect(out).not.toContain('\uFFFD')
  })

  it('ellipsizes on a code-point boundary', () => {
    // A byte budget wide enough to stay out of the way, so this pins the
    // character budget alone.
    const label = '\u{10400}'.repeat(120)
    const out = sanitizeLabel(label, { fallback: 'X', maxLen: 100, maxBytes: 10_000 })
    expect(Array.from(out)).toHaveLength(100)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\uFFFD')
  })

  it('honors the byte ceiling within the character budget', () => {
    // 100 astral code points is 400 bytes, so a name the character budget
    // accepts is one ext4 and APFS reject with ENAMETOOLONG. The default
    // budget is NAME_MAX, and the cut still lands on a code-point boundary.
    const label = '\u{10400}'.repeat(120)
    const out = sanitizeLabel(label, { fallback: 'X', maxLen: 100 })
    expect(Array.from(out).length).toBeLessThan(100)
    expect(byteLength(out)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\uFFFD')
  })

  it('takes the byte budget as the caller remaining room', () => {
    // What the gdocs/gmail filenames pass: NAME_MAX minus the id, the
    // separators and the suffix.
    const out = sanitizeLabel('会'.repeat(200), { fallback: 'X', maxLen: 100, maxBytes: 60 })
    expect(byteLength(out)).toBeLessThanOrEqual(60)
    expect(out.endsWith('...')).toBe(true)
    expect(out).not.toContain('\uFFFD')
  })

  it('drops the ellipsis when it cannot fit', () => {
    // Three dots and nothing is not a name; a budget this small yields
    // whatever of the label actually fits.
    expect(sanitizeLabel('abcdef', { fallback: 'X', maxLen: 100, maxBytes: 2 })).toBe('ab')
  })

  it('keeps non-ascii letters, matching python', () => {
    // The per-backend copies this replaced used `\w`, which is ascii-only in
    // javascript, so a CJK title became a row of underscores while python --
    // where `\w` is unicode-aware -- kept it.
    expect(sanitizeLabel('日本語の文書', { fallback: 'X', maxLen: 100 })).toBe('日本語の文書')
    expect(sanitizeLabel('Café Notes', { fallback: 'X', maxLen: 100 })).toBe('Café_Notes')
  })
})

describe('SAFE_SLASH', () => {
  it('is the one character pathSafeName renders a slash as', () => {
    // Every backend that renders an API name as a path segment emits it,
    // and the codec that inverts the rendering imports it from here rather
    // than copying the literal.
    expect(SAFE_SLASH).toBe('\u2215')
    expect(pathSafeName('a/b')).toBe(`a${SAFE_SLASH}b`)
  })
})

describe('ESCAPE_LEAD', () => {
  it('leads a dot-led name so it stays listable and openable', () => {
    // The hierarchy classifies a dot-led segment as hidden: it is dropped
    // from every listing and refused as a path. A name that starts with a
    // dot therefore carries the escape lead, which the segment codec reads
    // as "the next character is literal".
    expect(ESCAPE_LEAD).toBe('\u2044')
    expect(pathSafeName('.env')).toBe(`${ESCAPE_LEAD}.env`)
    expect(pathSafeName('..')).toBe(`${ESCAPE_LEAD}..`)
    expect(pathSafeName('./x')).toBe(`${ESCAPE_LEAD}.${SAFE_SLASH}x`)
    expect(pathSafeName('a.b')).toBe('a.b')
    expect(pathSafeName(' ')).toBe('unknown')
  })
})

describe('isBlank', () => {
  it('is the White_Space property in both languages', () => {
    // `trim` also strips U+FEFF and leaves U+0085, and python's `str.strip`
    // also strips U+001C..U+001F, so the same value was blank in one runtime
    // and spelled in the other. Blank is Unicode's White_Space property,
    // spelled out once here and read by every name sanitizer and the codec.
    for (const blank of ['', ' ', '\t\n', '\u0085', '\u00a0', '\u2028', '\u3000']) {
      expect(isBlank(blank)).toBe(true)
      expect(pathSafeName(blank)).toBe('unknown')
      expect(sanitizeName(blank)).toBe('unknown')
      expect(sanitizeLabel(blank, { fallback: 'X', maxLen: 10 })).toBe('X')
    }
    for (const spelled of ['\u001c', '\u001f', '\ufeff', 'a', ' a ']) {
      expect(isBlank(spelled)).toBe(false)
    }
    expect(pathSafeName('\ufeff')).toBe('\ufeff')
  })

  it('is the class the unsafe-character sweep reads too', () => {
    // `\s` kept U+FEFF here and U+001C in python, so the two runtimes
    // spelled one label differently; both now replace what is not
    // Unicode White_Space.
    for (const odd of ['\ufeff', '\u001c', '\u001f']) {
      expect(sanitizeName(`a${odd}b`)).toBe('a_b')
      expect(sanitizeLabel(`a${odd}b`, { fallback: 'X', maxLen: 10 })).toBe('a_b')
    }
    expect(sanitizeName('a\u0085b')).toBe('a\u0085b')
  })
})

it.each([-1, 0, 1, 2, 3, 4, 255, 2 ** 40])(
  'keeps UTF-8 and the BOM at byte budget %s',
  (budget) => {
    const expected = ['', '', '', '', '\ufeff', '\ufeff', '\ufeffé𐐀', '\ufeffé𐐀']
    const index = [-1, 0, 1, 2, 3, 4, 255, 2 ** 40].indexOf(budget)
    expect(truncateBytes('\ufeffé𐐀', budget)).toBe(expected[index])
  },
)

it('crosses the stream buffer boundary', () => {
  const text = 'é'.repeat(100_000) + '/.tail'
  expect(pathSafeName(text)).toBe('é'.repeat(100_000) + '∕.tail')
  expect(sanitizeName(text)).toBe('é'.repeat(100))
  expect(sanitizeLabel('abc', { fallback: 'X', maxLen: 100, maxBytes: -1 })).toBe('')
})

it('treats a lone surrogate as unsafe in a name and keeps it in a path', () => {
  expect(sanitizeName('\ud800abc')).toBe('abc')
  expect(sanitizeLabel('\udc80', { fallback: 'X', maxLen: 10 })).toBe('X')
  expect(pathSafeName('.x\udc80')).toBe('⁄.x\udc80')
  expect(isBlank('\udc80')).toBe(false)
})
