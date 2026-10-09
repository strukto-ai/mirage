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

import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { chunkAt, chunkParts, parseChunksValue, splitGeneric } from './split.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const TRY = "\nTry 'split --help' for more information."

async function runSplit(
  flags: CommandOpts['flags'],
  input = 'l1\nl2\nl3\nl4\n',
  sink?: Record<string, string>,
): Promise<Record<string, string>> {
  const written: Record<string, string> = sink ?? {}
  const opts = {
    stdin: ENC.encode(input),
    flags,
    cwd: '/',
    vfs: { kind: 'ram' } as never,
  } as CommandOpts
  await splitGeneric(
    [],
    opts,
    () => {
      throw new Error('paths are empty; the source is stdin')
    },
    (p, data) => {
      written[p.mountPath.replace(/^\//, '')] = DEC.decode(data)
      return Promise.resolve()
    },
  )
  return written
}

describe('split flag values', () => {
  it('splits by a suffixed byte count', async () => {
    const written = await runSplit({ bytes: '1k' }, 'A'.repeat(1500))
    expect(written.xaa?.length).toBe(1024)
    expect(written.xab?.length).toBe(476)
  })

  it('treats -a 0 as the default width instead of colliding names', async () => {
    // Regression: suffix length 0 rendered an empty suffix, so every
    // chunk landed on the same output path and only the last survived.
    const written = await runSplit({ suffix_length: '0', lines: '1' }, 'a\nb\n')
    expect(Object.keys(written).sort()).toEqual(['xaa', 'xab'])
  })

  it('auto-lengthens alpha suffixes past aa..yz instead of wrapping', async () => {
    // GNU reserves z as a growth prefix: aa..yz, then zaaa.. — index 676
    // must never wrap back onto xaa (pinned against coreutils 9.7).
    const written = await runSplit({ bytes: '1', suffix_length: '0' }, 'q'.repeat(652))
    expect(Object.keys(written).length).toBe(652)
    expect(written.xyz).toBe('q')
    expect(written.xzaaa).toBe('q')
    expect(written.xzaab).toBe('q')
    expect(written.xzz).toBeUndefined()
  })

  it('reads -t as one byte and keeps it on every record', async () => {
    // `\0` is the only escape GNU reads, and it is two characters on the
    // command line; everything else is literal, so a lone backslash and a
    // digit zero are ordinary separators. Each record keeps its terminator.
    const nul = await runSplit({ separator: '\\0', lines: '2' }, 'a\0b\0c\0')
    expect(nul.xaa).toBe('a\0b\0')
    expect(nul.xab).toBe('c\0')
    const digit = await runSplit({ separator: '0', lines: '2' }, 'a0b0c0')
    expect(digit.xaa).toBe('a0b0')
    const backslash = await runSplit({ separator: '\\', lines: '2' }, 'a\\b\\c\\')
    expect(backslash.xaa).toBe('a\\b\\')
  })

  it.each([
    ['XY', 'XY'],
    ['\\n', '\\\\n'],
    ['é', '\\303\\251'],
  ])(
    'refuses the multi-byte separator %j instead of taking its first byte',
    async (separator, shown) => {
      // This used to encode the value and keep byte 0, so `-t XY` split on
      // 'X' where GNU refuses to run at all. 'é' is one character but two
      // UTF-8 bytes, and GNU counts bytes and escapes them.
      await expect(runSplit({ separator })).rejects.toThrow(
        new UsageError(`split: multi-character separator '${shown}'`, 1),
      )
    },
  )

  it('exhausts an explicit width instead of wrapping onto earlier chunks', async () => {
    // GNU keeps the chunks already written and fails on the next name.
    const sink: Record<string, string> = {}
    await expect(
      runSplit({ bytes: '1', suffix_length: '1' }, 'q'.repeat(27), sink),
    ).rejects.toThrow(new UsageError('split: output file suffixes exhausted', 1))
    expect(Object.keys(sink).length).toBe(26)
    expect(sink.xa).toBe('q')
    expect(sink.xz).toBe('q')
  })

  it('an explicit start value pins the width and exhausts past it', async () => {
    // Deliberate divergence for hex: GNU 9.7 with --hex-suffixes=f0 walks
    // past its alphabet into non-hex names; mirage exhausts cleanly.
    const sink: Record<string, string> = {}
    await expect(runSplit({ bytes: '1', numeric_suffixes: '98' }, 'qqq', sink)).rejects.toThrow(
      new UsageError('split: output file suffixes exhausted', 1),
    )
    expect(Object.keys(sink).sort()).toEqual(['x98', 'x99'])
  })

  // xstrtoumax skips leading whitespace and allows a single '+', so these are
  // valid counts (pinned against coreutils 9.7).
  it.each([
    [{ bytes: '+3' }, 'signed bytes'],
    [{ suffix_length: '+3', lines: '1' }, 'signed suffix length'],
  ] as [CommandOpts['flags'], string][])('accepts %j (%s)', async (flags) => {
    const written = await runSplit(flags, 'ab\ncd\n')
    expect(Object.keys(written).length).toBeGreaterThan(0)
  })

  // Regression: a junk -b fell through to line mode with lines_per_file=0
  // and wrote one output file per input line; junk -l swallowed the whole
  // input into a single file; junk -a collided every chunk onto one path.
  it.each([
    [{ bytes: '++10' }, "split: invalid number of bytes: '++10'"],
    [{ lines: '1k' }, "split: invalid number of lines: '1k'"],
    // A malformed head quotes the whole remainder after one leading kind
    // prefix, so an unprefixed spec names itself.
    [{ number: '+l/2' }, "split: invalid number of chunks: '+l/2'"],
    // Widths past 2**64 - 1 are refused at parse time; byte and line
    // counts saturate instead, so only -a gets the Value-too-large tail.
    [
      { suffix_length: '18446744073709551616', lines: '1' },
      "split: invalid suffix length: '18446744073709551616': Value too large for defined data type",
    ],
    [
      { numeric_suffixes: '100', lines: '1' },
      `split: numerical suffix start value is too large for the suffix length${TRY}`,
    ],
  ] as [CommandOpts['flags'], string][])(
    'rejects %j without writing anything',
    async (flags, message) => {
      let written: Record<string, string> = {}
      await expect(async () => {
        written = await runSplit(flags)
      }).rejects.toThrow(new UsageError(message, 1))
      expect(written).toEqual({})
    },
  )
})

// GNU strips ONE leading `l/` or `r/` and then cuts what is left at its
// FIRST slash: a head it cannot parse names the whole remainder, everything
// else names the tail. mirage used to name the whole spec whenever the head
// was bad, which is right only when no kind prefix was typed. Every row
// measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw `bytes`
// argv. Mirrors test_split.py.
const CHUNK_SPECS: [string, string][] = [
  ['l/xé/4', 'x\\303\\251/4'],
  ['+l/2', '+l/2'],
  ['l/2/3/4', '3/4'],
]

describe('split -n names the component GNU names', () => {
  it.each(CHUNK_SPECS)('names %j as %j', async (value, named) => {
    await expect(runSplit({ number: value })).rejects.toThrow(
      new UsageError(`split: invalid number of chunks: '${named}'`, 1),
    )
  })

  it.each([
    ['2/4', { kind: 'bytes', count: 4, only: 2 }],
    ['l/2/4', { kind: 'l', count: 4, only: 2 }],
    ['r/2/4', { kind: 'r', count: 4, only: 2 }],
  ])('reads %j as chunk K of N', (value, spec) => {
    expect(parseChunksValue(value)).toEqual(spec)
  })
})

// Every row measured on coreutils 9.7 (debian:stable-slim).
describe('split -n cuts the way GNU cuts', () => {
  const LINES = ENC.encode('line1\nline2\nline3\nline4\nline5\n')
  const text = (parts: Uint8Array[]): string[] => parts.map((p) => DEC.decode(p))

  it('leaves the tail chunks empty when the input is shorter than N', () => {
    expect(text([...chunkParts(ENC.encode('ab'), parseChunksValue('5'), 0x0a)])).toEqual([
      'a',
      'b',
      '',
      '',
      '',
    ])
  })

  it.each([['l/3', ['line1\nline2\n', 'line3\nline4\n', 'line5\n']]])(
    'keeps records whole under %j',
    (value, expected) => {
      expect(text([...chunkParts(LINES, parseChunksValue(value), 0x0a)])).toEqual(expected)
    },
  )

  it('leaves a chunk a long record swallowed whole empty', () => {
    expect(text([...chunkParts(ENC.encode('aaaaaa\nb\n'), parseChunksValue('l/3'), 0x0a)])).toEqual(
      ['aaaaaa\n', '', 'b\n'],
    )
  })

  it('gives an unterminated tail to the chunk it started in', () => {
    expect(text([...chunkParts(ENC.encode('aa\nbb\ncc'), parseChunksValue('l/2'), 0x0a)])).toEqual([
      'aa\nbb\n',
      'cc',
    ])
  })

  it('reads one chunk without cutting the rest', () => {
    // coreutils 9.7 over `abc\ndef\n`, each instant however large N is.
    const huge = '1000000000'
    const data = ENC.encode('abc\ndef\n')
    const at = (spec: string, k: number): string =>
      DEC.decode(chunkAt(data, parseChunksValue(spec), 0x0a, k))
    expect(at(`2/${huge}`, 2)).toBe('b')
    expect(at(`l/5/${huge}`, 5)).toBe('def\n')
    expect(at(`r/2/${huge}`, 2)).toBe('def\n')
  })

  it('pads the empty tail lazily', () => {
    const parts = chunkParts(ENC.encode('ab'), parseChunksValue('1000000000'), 0x0a)
    const first = [parts.next(), parts.next(), parts.next(), parts.next()]
    expect(first.map((r) => DEC.decode(r.value as Uint8Array))).toEqual(['a', 'b', '', ''])
  })

  it('refuses a chunk count past the safe integer range', () => {
    expect(() => parseChunksValue('99999999999999999999999')).toThrow(
      "split: invalid number of chunks: '99999999999999999999999'",
    )
  })
})

// All four of split's count clauses name the refused word through gnulib's
// quote(), so a byte outside 0x20-0x7e comes back escaped rather than
// interpolated raw. `-n` quotes only the trailing component, which is the
// one the escaping applies to. Every row measured against GNU coreutils 9.4
// under `LC_ALL=C` with a raw `bytes` argv. Mirrors test_split.py.
const QUOTED_VALUES: [string, string][] = [
  ['1é', '1\\303\\251'],
  ['1\r', '1\\r'],
]

describe('split quotes the word it names', () => {
  // `-n l/<w>` names the component, so the escaping travels with it.
  const CLAUSES: [CommandOpts['flags'], string, string][] = [
    [{}, 'bytes', 'invalid number of bytes'],
    [{}, 'lines', 'invalid number of lines'],
    [{}, 'number', 'invalid number of chunks'],
    [{ prefix: 'l/' }, 'number', 'invalid number of chunks'],
    [{}, 'suffix_length', 'invalid suffix length'],
  ]
  it.each(QUOTED_VALUES.flatMap((row) => CLAUSES.map((clause) => [...row, ...clause] as const)))(
    'escapes %j in the clause of %s %s',
    async (value, escaped, extra, flag, clause) => {
      const typed = (typeof extra.prefix === 'string' ? extra.prefix : '') + value
      await expect(runSplit({ [flag]: typed })).rejects.toThrow(
        new UsageError(`split: ${clause}: '${escaped}'`, 1),
      )
    },
  )

  // The digit run cannot itself carry a byte quote() would escape, so a
  // blank leading run is what puts one in the slot: `strtoumax` skips
  // leading whitespace, and the raw argument including it is what GNU
  // quotes (measured: `split -a $'\r18446744073709551616'`).
  it('escapes the word in the Value-too-large tail', async () => {
    await expect(runSplit({ suffix_length: '\r18446744073709551616' })).rejects.toThrow(
      new UsageError(
        "split: invalid suffix length: '\\r18446744073709551616': " +
          'Value too large for defined data type',
        1,
      ),
    )
  })
})

// The suffix-start clause puts its word FIRST, where the four count clauses
// put it last, and it escapes the word the same way (measured on GNU
// coreutils 9.4 for both spellings). The empty word is absent on purpose:
// `--numeric-suffixes=` is not a refusal in GNU at all, it exits 0, which
// is a separate divergence from the escaping.
describe('split quotes the suffix start value', () => {
  it.each(
    QUOTED_VALUES.flatMap(([value, escaped]) => [
      [value, escaped, 'numeric_suffixes', 'numerical'],
      [value, escaped, 'hex_suffixes', 'hexadecimal'],
    ]),
  )('escapes %j in the %s start clause', async (value, escaped, flag, kind) => {
    await expect(runSplit({ [flag]: value, lines: '1' })).rejects.toThrow(
      new UsageError(`split: '${escaped}': invalid start value for ${kind} suffix${TRY}`, 1),
    )
  })
})

// No operand to read a prefix from: `x` in the working directory names the
// outputs (GNU). Mirrors test_split.py.
describe('split names stdin outputs in the working directory', () => {
  it.each([['/data/sub', ['/data/sub/xaa', '/data/sub/xab']]])(
    'addresses each output under %s',
    async (cwd, named) => {
      const specs: PathSpec[] = []
      const opts = {
        stdin: ENC.encode('a\nb\n'),
        flags: { lines: '1' },
        cwd,
        mountPrefix: '/data',
      } as CommandOpts
      await splitGeneric(
        [],
        opts,
        () => {
          throw new Error('paths are empty; the source is stdin')
        },
        (p) => {
          specs.push(p)
          return Promise.resolve()
        },
      )
      expect(specs.map((p) => p.virtual)).toEqual(named)
    },
  )
})
