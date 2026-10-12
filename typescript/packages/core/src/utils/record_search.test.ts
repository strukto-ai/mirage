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
import { KEPT_TEXT_MAX, keptText, mayHold, nonPlainWords, recordQueries } from './record_search.ts'

const KEYS = new Set(['subject', 'body_text', 'flags', 'true', 'seen'])

// Twin of test_a_search_covers_every_record_the_text_may_match: digits,
// quotes, escapes and non-ASCII can match an id, a count or a JSON escape; a
// key, a fixed value or a hex run can match outside the text the provider
// searches, and so can a substring of a key. A text starting with a letter an
// escape ends with (\n, \b, \u001b) is searched without that letter too, and
// that letter alone is refused.
describe('recordQueries', () => {
  it.each<[string, boolean, string[] | null]>([
    ['plan', false, ['plan']],
    ['plan review', true, ['plan review']],
    ['nice', true, ['nice', 'ice']],
    ['budget', false, ['udget']],
    ['n cat', true, ['n cat', 'cat']],
    ['n', true, null],
    ['subject', true, null],
    ['ject', false, null],
    ['ject', true, ['ject']],
    ['ject plan', false, ['ject plan']],
    ['Seen', true, null],
    ['beef', true, null],
    ['deploy 42', true, null],
    ['say "hi"', false, null],
    ['caf\u00e9', false, null],
    ['back\\slash', false, null],
    ['   ', false, null],
  ])('%j (whole word %s) searches %j', (text, wholeWord, queries) => {
    expect(recordQueries(text, KEYS, wholeWord)).toEqual(queries)
  })
})

// Twins of the non_plain_words, may_hold and kept_text tests in
// python/tests/utils/test_record_search.py.
it('splits non-plain words at ASCII whitespace', () => {
  const text = 'left\ufeffright plain a-b\u00a0c\tx sync-up.'
  expect(nonPlainWords(text)).toEqual(['left\ufeffright', 'a-b\u00a0c', 'sync-up.'])
})

it('holds a record when each word is found or kept', () => {
  const asked = [['visit', 'wombat']]
  const named = new Map([
    ['visit', new Set(['r1'])],
    ['wombat', new Set<string>()],
  ])
  expect(mayHold(asked, named, 'r1', 'see wombat.example.com')).toBe(true)
  expect(mayHold(asked, named, 'r1', 'nothing kept')).toBe(false)
  expect(mayHold(asked, named, 'r2', 'see wombat.example.com')).toBe(false)
})

it('keeps lowercased text up to the cap', () => {
  const enc = new TextEncoder()
  expect(keptText(enc.encode('{"Name":"Ada"}'))).toEqual({ text: '{"name":"ada"}' })
  expect(keptText(new Uint8Array(KEPT_TEXT_MAX + 1))).toEqual({})
  expect(keptText(new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69]))).toEqual({ text: '\ufeffhi' })
})
