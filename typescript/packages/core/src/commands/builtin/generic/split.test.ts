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

import type { CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { splitGeneric } from './split.ts'

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
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
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

  it('honors a hex suffix start in base 16', async () => {
    const written = await runSplit({ hex_suffixes: '10', lines: '1' }, 'a\nb\n')
    expect(Object.keys(written).sort()).toEqual(['x10', 'x11'])
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

  it('auto-lengthens numeric and hex suffixes behind their reserved digit', async () => {
    const numeric = await runSplit({ bytes: '1', numeric_suffixes: true }, 'q'.repeat(92))
    expect(numeric.x89).toBe('q')
    expect(numeric.x9000).toBe('q')
    expect(numeric.x9001).toBe('q')
    expect(numeric.x90).toBeUndefined()
    const hex = await runSplit({ bytes: '1', hex_suffixes: true }, 'q'.repeat(242))
    expect(hex.xef).toBe('q')
    expect(hex.xf000).toBe('q')
    expect(hex.xf0).toBeUndefined()
  })

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
    [{ bytes: ' 3' }, 'spaced bytes'],
    [{ lines: '+1' }, 'signed lines'],
    [{ number: 'l/+2' }, 'signed chunk spec'],
    [{ number: '+2/3' }, 'signed chunk K'],
    [{ suffix_length: '+3', lines: '1' }, 'signed suffix length'],
  ] as [CommandOpts['flags'], string][])('accepts %j (%s)', async (flags) => {
    const written = await runSplit(flags, 'ab\ncd\n')
    expect(Object.keys(written).length).toBeGreaterThan(0)
  })

  // Regression: a junk -b fell through to line mode with lines_per_file=0
  // and wrote one output file per input line; junk -l swallowed the whole
  // input into a single file; junk -a collided every chunk onto one path.
  it.each([
    [{ bytes: 'abc' }, "split: invalid number of bytes: 'abc'"],
    [{ bytes: '+0' }, "split: invalid number of bytes: '+0'"],
    [{ bytes: '++10' }, "split: invalid number of bytes: '++10'"],
    [{ bytes: '-10' }, "split: invalid number of bytes: '-10'"],
    [{ bytes: '+ 10' }, "split: invalid number of bytes: '+ 10'"],
    [
      { numeric_suffixes: '+5', lines: '1' },
      `split: '+5': invalid start value for numerical suffix${TRY}`,
    ],
    [{ bytes: '0x10' }, "split: invalid number of bytes: '0x10'"],
    [{ bytes: '0' }, "split: invalid number of bytes: '0'"],
    [{ bytes: '1g' }, "split: invalid number of bytes: '1g'"],
    [{ lines: 'abc' }, "split: invalid number of lines: 'abc'"],
    [{ lines: '0' }, "split: invalid number of lines: '0'"],
    [{ lines: '1k' }, "split: invalid number of lines: '1k'"],
    [{ number: 'l/abc' }, "split: invalid number of chunks: 'abc'"],
    [{ number: '0' }, "split: invalid number of chunks: '0'"],
    // A malformed head (signed kind letter, junk kind) quotes the whole spec.
    [{ number: '+l/2' }, "split: invalid number of chunks: '+l/2'"],
    [{ number: 'x/3' }, "split: invalid number of chunks: 'x/3'"],
    [{ suffix_length: 'abc', lines: '1' }, "split: invalid suffix length: 'abc'"],
    // Widths past 2**64 - 1 are refused at parse time; byte and line
    // counts saturate instead (split -b 1Y is a valid spelling of "one
    // output file"), so only -a gets the Value-too-large tail.
    [
      { suffix_length: '18446744073709551616', lines: '1' },
      "split: invalid suffix length: '18446744073709551616': Value too large for defined data type",
    ],
    [
      { numeric_suffixes: 'zz', lines: '1' },
      `split: 'zz': invalid start value for numerical suffix${TRY}`,
    ],
    [
      { hex_suffixes: 'zz', lines: '1' },
      `split: 'zz': invalid start value for hexadecimal suffix${TRY}`,
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
