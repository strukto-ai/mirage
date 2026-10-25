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
import { UsageError } from '../errors.ts'
import { parseFlags } from './generic/rg.ts'
import { openRg, streamHaystack } from './rg_stream.ts'
import { RgBinary, type RgFlags, smartCaseFolds, transcoded } from './rg_search.ts'

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
  const pat = await openRg(pattern, false, f)
  try {
    for await (const chunk of streamHaystack(
      source(data),
      pat,
      f,
      'f',
      label,
      tally,
      undefined,
      true,
      false,
    )) {
      out.push(chunk)
    }
    return out.map((c) => DEC.decode(c)).join('')
  } finally {
    pat.stream.close()
  }
}

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

describe('streamHaystack', () => {
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

  it('falls back to PCRE2 under auto only when the default refuses', async () => {
    expect(await search('aa\nab\n', '(a)\\1', { engine: 'auto' })).toBe('aa\n')
    await expect(openRg('(a)\\1', false, flagsOf({}))).rejects.toThrow(
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

async function* parts(...chunks: number[][]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield new Uint8Array(chunk)
  }
}

async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = []
  for await (const chunk of stream) out.push(...chunk)
  return out
}

describe('transcoded', () => {
  // encoding_rs_io as ripgrep 14.1.1 runs it: a mark is dropped wherever the
  // chunks split it, a UTF-16 mark overrides -E and a UTF-8 one does not, and
  // only a decoder drops a second mark of its own.
  it.each<[string, number[][], number[]]>([
    ['auto', [[0xef], [0xbb, 0xbf, 0x63, 0x61, 0x66, 0xe9]], [0x63, 0x61, 0x66, 0xe9]],
    [
      'auto',
      [
        [0xff, 0xfe, 0x68, 0x00],
        [0x69, 0x00],
      ],
      [0x68, 0x69],
    ],
    ['windows-1252', [[0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xe9]], [...ENC.encode('café')]],
    ['UTF-16LE', [[0xfe, 0xff, 0x00, 0x68]], [0x68]],
    ['UTF-8', [[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x68, 0x69]], [0x68, 0x69]],
    ['auto', [[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x68, 0x69]], [0xef, 0xbb, 0xbf, 0x68, 0x69]],
    ['UTF-8', [[0x63, 0x61, 0x66, 0xe9]], [...ENC.encode('caf\ufffd')]],
    ['auto', [], []],
  ])('reads marks as ripgrep under %s', async (encoding, chunks, want) => {
    expect(await bytesOf(transcoded(parts(...chunks), encoding))).toEqual(want)
  })

  it('closes its source', async () => {
    const closed: boolean[] = []
    async function* input(): AsyncGenerator<Uint8Array> {
      try {
        await Promise.resolve()
        yield ENC.encode('abc')
        yield ENC.encode('def')
      } finally {
        closed.push(true)
      }
    }
    const stream = transcoded(input(), 'auto')
    expect(DEC.decode((await stream.next()).value as Uint8Array)).toBe('abc')
    await stream.return(undefined)
    expect(closed).toEqual([true])
    // An iterable that hands out a fresh iterator has that one closed.
    const fresh = transcoded({ [Symbol.asyncIterator]: () => input() }, 'auto')
    expect(DEC.decode((await fresh.next()).value as Uint8Array)).toBe('abc')
    await fresh.return(undefined)
    expect(closed).toEqual([true, true])
  })

  it('feeds the search what -E names', async () => {
    async function found(data: number[], pattern: string, flags: Record<string, FlagValue>) {
      const f = flagsOf(flags)
      const tally = { selected: false }
      const pat = await openRg(pattern, false, f)
      try {
        const out = await bytesOf(
          streamHaystack(parts(data), pat, f, 'f', null, tally, undefined, true, false),
        )
        return [DEC.decode(new Uint8Array(out)), tally.selected]
      } finally {
        pat.stream.close()
      }
    }
    expect(await found([0xff, 0xfe, 0x68, 0, 0x69, 0, 0x0a, 0], 'hi', {})).toEqual(['hi\n', true])
    expect(await found([0x63, 0x61, 0x66, 0xe9, 0x0a], 'café', { encoding: 'latin1' })).toEqual([
      'café\n',
      true,
    ])
    expect(await found([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a], '^hi', { encoding: 'none' })).toEqual([
      '',
      false,
    ])
  })

  it.each<[Record<string, FlagValue>, string]>([
    [{}, 'auto'],
    [{ encoding: 'latin1' }, 'windows-1252'],
    [{ encoding: 'none' }, 'none'],
    [{ encoding: 'latin1', no_encoding: true }, 'auto'],
  ])('resolves -E from %j', (flags, want) => {
    expect(flagsOf(flags).encoding).toBe(want)
  })

  it('refuses a label naming no encoding', () => {
    expect(() => flagsOf({ encoding: 'utf16le' })).toThrow(UsageError)
    expect(() => flagsOf({ encoding: 'utf16le' })).toThrow(/unknown encoding: utf16le$/)
  })
})
