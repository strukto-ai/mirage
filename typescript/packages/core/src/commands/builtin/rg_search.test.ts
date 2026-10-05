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

import { describe, expect, it, vi } from 'vitest'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { materialize } from '../../io/types.ts'
import { specOf } from '../spec/builtins.ts'
import { FlagView } from '../spec/flag_view.ts'
import type { FlagValue } from '../spec/types.ts'
import { parseFlags, rgMatcher } from './generic/rg.ts'
import {
  ByteCursor,
  NonmatchStop,
  RgBinary,
  type RgFlags,
  expand,
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
    const re = /a(?<name>b)/
    const m = re.exec('ab')
    expect(m).not.toBeNull()
    if (m !== null) expect(expand(template, m, re)).toBe(want)
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

describe.each(['needle', 'needle|qqzzyy', 'nee.le', '\\bneedle\\b', '(?:needle|other)+'])(
  'block search %s',
  (pattern) => {
    it.each([
      { count: true },
      { files_with_matches: true },
      {},
      { ignore_case: true, count: true },
      { ignore_case: true, files_with_matches: true },
      { ignore_case: true },
      { word_regexp: true, count: true },
      { line_regexp: true, count: true },
      { null_data: true, count: true },
      { null_data: true },
    ])('does not read each nonmatching record: %j', async (flags) => {
      const lines = vi.spyOn(AsyncLineIterator.prototype, 'readline')
      const records = vi.spyOn(AsyncLineIterator.prototype, 'readUntil')
      try {
        const data = ('abcdefg' + ('null_data' in flags ? '\0' : '\n')).repeat(40000)
        expect(await search(data, pattern, flags)).toBe('')
        expect(lines.mock.calls.length + records.mock.calls.length).toBeLessThan(50)
      } finally {
        lines.mockRestore()
        records.mockRestore()
      }
    })
  },
)

it.each([1, 7, 16384, 65536])(
  'preserves records and offsets across %i-byte chunks',
  async (size) => {
    const data = ENC.encode(
      'abcdefg\n'.repeat(size < 10 ? 200 : 9000) +
        'é NEEDLE\nother\n' +
        'abcdefg\n'.repeat(size < 10 ? 200 : 9000) +
        'needle',
    )
    async function* input(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
    }
    for (const flags of [
      { line_number: true, byte_offset: true, ignore_case: true },
      { count: true, ignore_case: true },
      { files_with_matches: true, ignore_case: true },
      { after_context: 1, before_context: 1, ignore_case: true },
      { invert_match: true, count: true },
      { stop_on_nonmatch: true, ignore_case: true },
    ]) {
      const f = flagsOf(flags)
      const pat = rgMatcher('needle|other', false, f)
      const fast = { selected: false },
        slow = { selected: false }
      const actual = await materialize(searchHaystack(input(), pat, f, 'f', null, fast))
      const skip = vi
        .spyOn(AsyncLineIterator.prototype, 'skipNonmatchingLines')
        .mockReturnValue([0, 0])
      let expected: Uint8Array
      try {
        expected = await materialize(searchHaystack(input(), pat, f, 'f', null, slow))
      } finally {
        skip.mockRestore()
      }
      expect([actual, fast]).toEqual([expected, slow])
    }
  },
)

it.each([
  {},
  { count: true },
  { count_matches: true },
  { files_with_matches: true },
  { files_without_match: true },
  { quiet: true },
  { max_count: 1 },
  { invert_match: true },
  { context: 2 },
  { passthru: true },
  { stop_on_nonmatch: true },
  { null_data: true },
  { only_matching: true },
  { word_regexp: true },
])('preserves rg output and offsets with filtering disabled: %j', async (flags) => {
  const data =
    'abc\n'.repeat(200) +
    'NEEDLE\nnone\nneedle needle\nſ\nK\nİ\nı\n' +
    'abc\n'.repeat(200) +
    'needle'
  const opts = { ...flags, ignore_case: true, line_number: true, byte_offset: true }
  for (const pattern of ['needle|qqzzyy', 'nee.le', '\\bneedle\\b', '(?:needle)?', 's|k|i']) {
    const skip = vi
      .spyOn(AsyncLineIterator.prototype, 'skipNonmatchingLines')
      .mockReturnValue([0, 0])
    let expected: string
    try {
      expected = await search(data, pattern, opts)
    } finally {
      skip.mockRestore()
    }
    expect(await search(data, pattern, opts)).toBe(expected)
  }
})

// ripgrep 14.1.1 through PCRE2: `rg -oP`, `-r`, `-b` and `--column` report
// the match from its last `\\K`. Mirrors `test_rg_search.py`.
describe('PCRE2 keep', () => {
  it.each([
    ['a\\Ka', 'aaa\n', { only_matching: true, pcre2: true }, 'a\n'],
    ['a\\Kbc', 'abc\n', { only_matching: true, byte_offset: true, pcre2: true }, '1:bc\n'],
    ['a\\Kbc', 'abc\n', { column: true, pcre2: true }, '1:2:abc\n'],
    ['a\\Kb', 'abc\n', { replace: 'X', pcre2: true }, 'aXc\n'],
    ['a\\K(b)', 'abc\n', { replace: '[$1]', pcre2: true }, 'a[b]c\n'],
    ['(?<=id=)[0-9]+', 'id=42\n', { only_matching: true, pcre2: true }, '42\n'],
  ] as [string, string, Record<string, FlagValue>, string][])(
    '%j over %j',
    async (pattern, data, flags, out) => {
      expect(await search(data, pattern, flags)).toBe(out)
    },
  )

  it('takes the engine the line names last', () => {
    expect(flagsOf({}).engine).toBe('default')
    expect(flagsOf({ pcre2: true }).engine).toBe('pcre2')
    expect(flagsOf({ engine: 'auto' }).engine).toBe('auto')
    expect(() => flagsOf({ engine: 'foo' })).toThrow(
      "rg: error parsing flag --engine: unrecognized regex engine 'foo'",
    )
  })

  it('falls back to PCRE2 under auto only when the default refuses', () => {
    expect(rgMatcher('(a)\\1', false, flagsOf({ engine: 'auto' })).test('aa')).toBe(true)
    expect(() => rgMatcher('(a)\\1', false, flagsOf({}))).toThrow(
      /backreferences are not supported/,
    )
  })
})

async function readAll(binary: RgBinary, source: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const block of binary.read(source)) out.push(DEC.decode(block))
  return out
}

describe('RgBinary', () => {
  it("ends a walked file's first buffer at a NUL as it arrives", async () => {
    // The first buffer is still growing toward its first newline, so the NUL
    // is in it and ripgrep reads no further.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* source(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([...new Uint8Array(10000).fill(0x78), 0])
      throw new Error('read past the NUL')
    }
    const binary = new RgBinary('quit')
    expect(await readAll(binary, source())).toEqual([])
    expect([binary.skipped, binary.offset]).toEqual([true, 10000])
  })

  it('joins the chunks a file serves into one first read', async () => {
    // Twenty 8 KiB chunks with no newline grow one first buffer; the file ends
    // before the step past the newline, so it is all one read.
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* source(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < 20; i++) yield new Uint8Array(8192).fill(0x79)
      yield ENC.encode('\nz\n')
    }
    const binary = new RgBinary('quit')
    expect(await readAll(binary, source())).toEqual(['y'.repeat(163840) + '\nz\n'])
    expect(binary.offset).toBeNull()
  })
})
