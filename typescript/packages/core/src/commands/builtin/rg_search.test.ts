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
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/flag_view.ts'
import type { FlagValue } from '../spec/types.ts'
import { parseFlags, rgMatcher } from './generic/rg.ts'
import {
  ByteCursor,
  NonmatchStop,
  type RgFlags,
  expand,
  hostNamedGroups,
  replaceAll,
  rustMatches,
  searchHaystack,
  smartCaseFolds,
} from './rg_search.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function flagsOf(flags: Record<string, FlagValue>): RgFlags {
  return parseFlags(new FlagView(flags, specOf('rg')))
}

async function* source(data: string): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(data)
}

async function search(
  data: string,
  pattern: string,
  flags: Record<string, FlagValue>,
  label: string | null = null,
): Promise<string> {
  const f = flagsOf(flags)
  const out: Uint8Array[] = []
  const tally = { selected: false }
  for await (const chunk of searchHaystack(
    source(data),
    rgMatcher(pattern, false, f),
    f,
    'f',
    label,
    tally,
  )) {
    out.push(chunk)
  }
  return out.map((c) => DEC.decode(c)).join('')
}

describe('rustMatches', () => {
  it('skips the empty match a match ends at', () => {
    // `b*` over `abc` is empty, `b`, empty.
    const spans = [...rustMatches(/b*/, 'abc')].map((m) => [m.index, m.index + m[0].length])
    expect(spans).toEqual([
      [0, 0],
      [1, 2],
      [3, 3],
    ])
  })
})

describe('expand', () => {
  it.each([
    ['<$1>', '<b>'],
    ['<${1}>', '<b>'],
    ['<$name>', '<b>'],
    ['<$1x>', '<>'],
    ['<$$>', '<$>'],
    ['<$>', '<$>'],
    ['<$9>', '<>'],
  ])("reads %s as Rust's Captures::expand", (template, want) => {
    const m = /a(?<name>b)/.exec('ab')
    expect(m).not.toBeNull()
    if (m !== null) expect(expand(template, m)).toBe(want)
  })
})

describe('replaceAll', () => {
  it('reports where each replacement landed', () => {
    expect(replaceAll(/o/, 'foo', 'XY')).toEqual([
      'fXYXY',
      [
        [1, 3],
        [3, 5],
      ],
    ])
  })
})

describe('smartCaseFolds', () => {
  it.each([
    ['hello', false, true],
    ['Hello', false, false],
    ['\\w+', false, false],
    ['\\Whello', false, true],
    ['[A-Z]', false, false],
    ['a{2}', false, true],
    ['\\x41', false, false],
    ['H.llo', true, false],
  ])('%s (fixed %s) folds: %s', (pattern, fixed, folds) => {
    expect(smartCaseFolds(pattern, fixed)).toBe(folds)
  })
})

describe('hostNamedGroups', () => {
  it.each([
    ['(?P<name>x)', '(?<name>x)'],
    ['(?<name>x)', '(?<name>x)'],
    ['(?<=a)b', '(?<=a)b'],
    ['\\(?P<x', '\\(?P<x'],
    ['[(?P<]x', '[(?P<]x'],
  ])('reads %s as %s', (pattern, host) => {
    expect(hostNamedGroups(pattern)).toBe(host)
  })
})

describe('ByteCursor', () => {
  it('counts each step from the last', () => {
    const cursor = new ByteCursor('café abc abc')
    expect([cursor.at(5), cursor.at(9)]).toEqual([6, 10])
  })
})

describe('NonmatchStop', () => {
  it('arms after the first selection', () => {
    const stop = new NonmatchStop(true, false)
    expect(stop.armed).toBe(false)
    stop.select()
    expect(stop.armed).toBe(true)
  })

  it('passes one line over when inverted', () => {
    const stop = new NonmatchStop(true, true)
    expect(stop.passesOver()).toBe(false)
    stop.select()
    expect(stop.passesOver()).toBe(true)
    expect(stop.armed).toBe(true)
    expect(stop.passesOver()).toBe(false)
  })
})

describe('searchHaystack', () => {
  it.each([
    [{}, 'a1\na2\n'],
    [{ after_context: '1' }, 'a1\na2\nb\n'],
    [{ count: true }, '2\n'],
    [{ passthru: true }, 'a1\na2\nb\n'],
    [{ invert_match: true }, 'b\nc\n'],
  ])('ends a file where ripgrep does under --stop-on-nonmatch: %j', async (flags, want) => {
    // ripgrep 14.1.1 over `a1 a2 b a3 c` with --stop-on-nonmatch.
    expect(await search('a1\na2\nb\na3\nc\n', 'a', { stop_on_nonmatch: true, ...flags })).toBe(want)
  })

  it('bounds -w with half boundaries', async () => {
    // ripgrep 14.1.1: -w is \b{start-half}...\b{end-half}, so `-foo` matches
    // after a space, which \b-foo\b never does.
    expect(await search('a -foo b\nx-foo\n', '-foo', { word_regexp: true })).toBe('a -foo b\n')
  })

  it('lets the later of -w and -x bound the pattern', async () => {
    const data = 'hello there\nhello\n'
    expect(await search(data, 'hello', { line_regexp: true, word_regexp: true })).toBe(data)
    expect(await search(data, 'hello', { word_regexp: true, line_regexp: true })).toBe('hello\n')
  })

  it('prints a --vimgrep record per match with its column', async () => {
    expect(await search('ab ab\n', 'ab', { vimgrep: true }, '/m')).toBe(
      '/m:1:1:ab ab\n/m:1:4:ab ab\n',
    )
    expect(await search('ab ab\n', 'ab', { vimgrep: true, no_column: true }, '/m')).toBe(
      '/m:1:ab ab\n/m:1:ab ab\n',
    )
  })

  it.each([
    [{ max_columns: '3' }, '[Omitted long matching line]\n'],
    [{ max_columns: '3', column: true }, '1:1:[Omitted long line with 2 matches]\n'],
    [{ max_columns: '3', max_columns_preview: true }, 'ab  [... omitted end of long line]\n'],
  ])('words what -M left out: %j', async (flags, want) => {
    expect(await search('ab ab\n', 'ab', flags)).toBe(want)
  })

  it('counts -o offsets in bytes', async () => {
    expect(await search('café abc abc\n', 'abc', { only_matching: true, byte_offset: true })).toBe(
      '6:abc\n10:abc\n',
    )
  })
})

it.each([
  [{ line_number: true, byte_offset: true }, '1:0:a\0' + '5:8:a\0'],
  [{ count: true }, '2\0'],
  [{ files_with_matches: true }, 'f\0'],
  [{ after_context: '1' }, 'a\0b\0--\0a\0'],
  [{ only_matching: true }, 'a\0a\0'],
  [{ max_count: '1' }, 'a\0'],
])('reads and prints NUL records with %j', async (flags, expected) => {
  expect(await search('a\0b\0c\0d\0a', 'a', { ...flags, null_data: true })).toBe(expected)
})

it.each([{}, { line_regexp: true }])(
  'NUL data anchors match embedded newlines with %j',
  async (flags) => {
    expect(await search('a\nb\0', '^a$', { ...flags, null_data: true })).toBe('a\nb\0')
  },
)
