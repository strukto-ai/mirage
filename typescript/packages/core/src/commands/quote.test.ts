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
import { quoteText, quoteWord } from './quote.ts'

// Every row a measured GNU coreutils 9.4 answer under `LC_ALL=C` (ground
// truth EX2-C, re-derived in NL3-A). GNU passes the word it names in a
// diagnostic through gnulib's `quote()`, which in the C locale escapes a
// backslash, a single quote, the seven named C escapes, and every other byte
// outside 0x20-0x7e as three octal digits.
//
// ONE table, not one per command: NL3-A placed all 255 reachable bytes in the
// quoted slot of `nl`, `expand`, `shuf`, `cut` and `expr`, and all five agreed
// byte for byte. That is why this lives as a leaf under `commands/` rather
// than as a copy in each command. Mirrored in test_quote.py as QUOTE_WORDS.
//
// A raw byte reaches a command as its U+DCxx sentinel, which is how the rows
// above 0x7f are spelled here.
const QUOTE_WORDS: [string, string][] = [
  ['a\\b', 'a\\\\b'],
  ['a\\\\b', 'a\\\\\\\\b'],
  ['\\', '\\\\'],
  ["a'b", "a\\'b"],
  ["'", "\\'"],
  ["a\\'b", "a\\\\\\'b"],
  ['', ''],
  // The seven escapes gnulib spells by name rather than in octal.
  ['a\x07b', 'a\\ab'],
  ['a\x08b', 'a\\bb'],
  ['a\tb', 'a\\tb'],
  ['a\nb', 'a\\nb'],
  ['a\x0bb', 'a\\vb'],
  ['a\fb', 'a\\fb'],
  ['a\rb', 'a\\rb'],
  // Everything else outside 0x20-0x7e is three octal digits, always padded so
  // a following digit cannot be read into the escape.
  ['a\x01b', 'a\\001b'],
  ['a\x1fb', 'a\\037b'],
  ['a\x7fb', 'a\\177b'],
  ['a\udc80b', 'a\\200b'],
  ['a\udcffb', 'a\\377b'],
  ['\x011', '\\0011'],
  // A multibyte character is its bytes, one octal escape each.
  ['é', '\\303\\251'],
  ['日', '\\346\\227\\245'],
  ['\u{1f600}', '\\360\\237\\230\\200'],
  // Printable ASCII passes through, including the ones a shell would care
  // about and the double quote gnulib leaves alone.
  ['a b', 'a b'],
  ['a"b', 'a"b'],
  ['a$b', 'a$b'],
  ['a`b', 'a`b'],
  ['~^:!%*', '~^:!%*'],
]

describe('quoteText matches gnulib', () => {
  it.each(QUOTE_WORDS)('%j', (word, escaped) => {
    expect(quoteText(word)).toBe(escaped)
  })
})

describe('quoteWord takes a byte view', () => {
  // One character per byte, which is the representation expr's parser runs
  // on. Only the rows that are already one byte per character are shared;
  // the multibyte ones belong to quoteText.
  it.each([
    ['a\\b', 'a\\\\b'],
    ["a'b", "a\\'b"],
    ['a\tb', 'a\\tb'],
    ['a\x01b', 'a\\001b'],
    ['a\xffb', 'a\\377b'],
    ['', ''],
  ] as [string, string][])('%j', (view, escaped) => {
    expect(quoteWord(view)).toBe(escaped)
  })
})

describe('every byte renders as printable ASCII', () => {
  // Whatever goes in, what comes out is safe to interpolate into a
  // diagnostic and encode, with no surrogate and no stray control byte
  // reaching stderr.
  it('for all 255 reachable bytes', () => {
    for (let b = 1; b < 256; b += 1) {
      const rendered = quoteWord(String.fromCharCode(b))
      for (const ch of rendered) {
        expect(ch >= ' ' && ch <= '~').toBe(true)
      }
    }
  })

  // The two entry points cannot drift, since one calls the other -- pinned
  // per byte anyway, because the encode in between is where a raw byte would
  // turn into U+FFFD's three bytes if the sentinel handling were dropped.
  it('and the two entry points agree per byte', () => {
    for (let b = 1; b < 256; b += 1) {
      const sentinel = String.fromCharCode(b >= 0x80 ? 0xdc00 + b : b)
      expect(quoteText(sentinel)).toBe(quoteWord(String.fromCharCode(b)))
    }
  })
})

describe('octal is padded to three digits', () => {
  it('so a following digit is not read into the escape', () => {
    expect(quoteWord('\x011')).toBe('\\0011')
    expect(quoteWord('\x0109')).toBe('\\00109')
  })
})
