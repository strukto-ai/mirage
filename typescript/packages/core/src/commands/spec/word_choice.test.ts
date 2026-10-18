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
import { matchWord, valueClasses } from './word_choice.ts'

// GNU coreutils 9.4 tables, as the commands that use them declare them.
const QUOTING_STYLES = [
  'literal',
  'shell',
  'shell-always',
  'shell-escape',
  'shell-escape-always',
  'c',
  'c-maybe',
  'escape',
  'locale',
  'clocale',
]
const LS_TIME = [
  ['atime', 'access', 'use'],
  ['ctime', 'status'],
  ['mtime', 'modification'],
  ['birth', 'creation'],
]
const DU_TIME = [
  ['atime', 'access', 'use'],
  ['ctime', 'status'],
]
const COLOR = [
  ['always', 'yes', 'force'],
  ['never', 'no', 'none'],
  ['auto', 'tty', 'if-tty'],
]
const LS_FORMAT = [
  ['verbose', 'long'],
  ['commas'],
  ['horizontal', 'across'],
  ['vertical'],
  ['single-column'],
]
const LS_SORT = ['none', 'time', 'size', 'extension', 'version', 'width']

const word = (w: string) => ({ matched: true, word: w })
const ambiguous = { matched: false, kind: 'ambiguous' }
const invalid = { matched: false, kind: 'invalid' }

describe('valueClasses', () => {
  it('takes a flat list as one value per word', () => {
    expect(valueClasses(['a', 'b'])).toEqual([['a'], ['b']])
    expect(valueClasses([['a', 'b'], 'c'])).toEqual([['a', 'b'], ['c']])
    expect(valueClasses([])).toEqual([])
  })
})

describe('matchWord', () => {
  // `ls --quoting-style=shell` exits 0 although three longer candidates
  // start with it, and `ls --color=no` is `never` although `none` does too.
  it.each([
    ['shell', 'shell'],
    ['shell-escape', 'shell-escape'],
    ['c', 'c'],
    ['shell-escape-always', 'shell-escape-always'],
  ])("takes the exact word %s over being a longer word's prefix", (value, matched) => {
    expect(matchWord(value, QUOTING_STYLES)).toEqual(word(matched))
  })

  it('answers an exact alias with its canonical word', () => {
    expect(matchWord('access', LS_TIME)).toEqual(word('atime'))
    expect(matchWord('no', COLOR)).toEqual(word('never'))
  })

  // `ls --sort=non`, `--sort=n`, `--quoting-style=lit`, `=shell-a`, `=loc`.
  it.each([
    ['non', 'none'],
    ['n', 'none'],
    ['t', 'time'],
    ['si', 'size'],
    ['e', 'extension'],
    ['w', 'width'],
  ])('answers the unambiguous prefix %s with its canonical word', (value, matched) => {
    expect(matchWord(value, LS_SORT)).toEqual(word(matched))
  })

  it.each([
    ['shell-a', 'shell-always'],
    ['shell-al', 'shell-always'],
    ['shell-escape-a', 'shell-escape-always'],
  ])('treats a hyphen as an ordinary character in %s', (value, matched) => {
    expect(matchWord(value, QUOTING_STYLES)).toEqual(word(matched))
  })

  // Ambiguity is decided on VALUES, not on how many words matched:
  // `ls -l --time=a` hits atime and access, one value, and exits 0.
  it.each([
    ['a', 'atime'],
    ['ac', 'atime'],
    ['u', 'atime'],
    ['m', 'mtime'],
    ['s', 'ctime'],
    ['b', 'birth'],
    ['cr', 'birth'],
    ['ct', 'ctime'],
  ])('accepts %s, several words of one value', (value, matched) => {
    expect(matchWord(value, LS_TIME)).toEqual(word(matched))
  })

  it('accepts three words of one value', () => {
    expect(matchWord('n', COLOR)).toEqual(word('never'))
    expect(matchWord('a', DU_TIME)).toEqual(word('atime'))
  })

  // `ls -l --time=c` hits ctime and creation, two values, exit 1.
  it.each([
    [LS_TIME, 'c'],
    [COLOR, 'a'],
    [LS_FORMAT, 'v'],
    [LS_FORMAT, 'ver'],
    [QUOTING_STYLES, 'l'],
    [QUOTING_STYLES, 's'],
    [QUOTING_STYLES, 'shell-e'],
  ])('calls %#: a word spanning two values ambiguous', (choices, value) => {
    expect(matchWord(value, choices)).toEqual(ambiguous)
  })

  it.each([
    [LS_SORT, 'zzz'],
    [LS_SORT, 'name'],
    [DU_TIME, 'm'],
    [QUOTING_STYLES, 'shellalways'],
  ])('calls %#: a word no candidate starts with invalid', (choices, value) => {
    expect(matchWord(value, choices)).toEqual(invalid)
  })

  // `ls --sort=NON`, `=NONE` and `=None` are all `invalid argument`, not
  // ambiguous and not accepted: strncmp is case-sensitive.
  it.each(['NON', 'NONE', 'None', 'N'])('matches case-sensitively (%s)', (value) => {
    expect(matchWord(value, LS_SORT)).toEqual(invalid)
  })

  // `ls --sort=` is `ambiguous argument ''` with no empty-word branch: `''`
  // is a prefix of every candidate, so it matches all of them and is refused
  // only because they span more than one value. A table whose words all mean
  // one value therefore ACCEPTS it.
  it('calls the empty word ambiguous by the ordinary rule', () => {
    expect(matchWord('', LS_SORT)).toEqual(ambiguous)
    expect(matchWord('', LS_TIME)).toEqual(ambiguous)
    expect(matchWord('', ['only'])).toEqual(word('only'))
    expect(matchWord('', [['quiet', 'silent']])).toEqual(word('quiet'))
  })

  it('calls no candidate at all invalid, even for the empty word', () => {
    expect(matchWord('', [])).toEqual(invalid)
    expect(matchWord('x', [])).toEqual(invalid)
  })
})
