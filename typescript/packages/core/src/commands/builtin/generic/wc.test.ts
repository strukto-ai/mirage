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

import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { formatWcLines, numberWidth, parseFlags, wcGeneric } from './wc.ts'

// GNU's ARGMATCH refusal names the refused word through gnulib's quote(),
// so a byte outside 0x20-0x7e comes back escaped rather than interpolated
// raw. Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a
// raw `bytes` argv (`wc --total=<w>`). Mirrors test_wc.py.
describe('wc quotes the word --total refuses', () => {
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
  ])('escapes %j in the --total clause', (value, escaped) => {
    const message = parseFlags({ total: value })
    expect(typeof message === 'string' ? message.split('\n')[0] : message).toBe(
      `wc: invalid argument '${escaped}' for '--total'`,
    )
  })
})

// Measured, coreutils 9.4: `--total=` is NOT the default -- GNU reads the
// empty word as a prefix of every candidate and answers `ambiguous argument
// ''`, which python used to take as `auto` and exit 0. Mirrors test_wc.py.
describe('wc --total refusal carries GNU candidate block', () => {
  it('words an empty value as ambiguous', () => {
    const message = parseFlags({ total: '' })
    expect(typeof message === 'string' ? message.split('\n')[0] : message).toBe(
      "wc: ambiguous argument '' for '--total'",
    )
  })

  // `wc --total=al` is `always` and `=au` is `auto` (measured, coreutils
  // 9.4), while the bare `a` they share spans two values. Mirrors
  // test_wc.py.
  it.each([
    ['al', 'always'],
    ['au', 'auto'],
  ])('resolves the unambiguous prefix %s', (value, total) => {
    const parsed = parseFlags({ total: value })
    expect(typeof parsed === 'string' ? parsed : parsed.total).toBe(total)
  })
})

describe('formatWcLines', () => {
  it('quotes only a name holding a newline', () => {
    // coreutils 9.7 wc.c: `strchr (file, '\n') ? quotef (file) : file`.
    expect(formatWcLines([{ values: [2], label: '/a/n\nq' }])).toEqual(["2 '/a/n'$'\\n''q'"])
    expect(formatWcLines([{ values: [2], label: '/a/b c' }])).toEqual(['2 /a/b c'])
  })
})

describe('numberWidth', () => {
  // coreutils 9.7: one operand with one count is unpadded; otherwise the
  // regular files' total size, at least 7 beside a stream or directory.
  it.each([
    [[null, 24], 2, 1, 7],
    [[123456789], 2, 1, 9],
  ] as const)('sizes %j over %i operands and %i counts as %i', (sizes, operands, counts, width) => {
    expect(numberWidth(sizes, operands, counts)).toBe(width)
  })
})

// Mirrors test_format_multi_asks_line_count_for_lines_alone in test_wc.py.
describe('wc asks the mount for a line count', () => {
  it('asks for lines alone and sizes the columns by the numbers', async () => {
    const reads: string[] = []
    const stream = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      reads.push(p.virtual)
      await Promise.resolve()
      yield new TextEncoder().encode('x y\n'.repeat(12345))
    }
    const lineCount = (p: PathSpec): Promise<number | null> =>
      Promise.resolve(p.virtual === '/a' ? 5 : null)
    const paths = [PathSpec.fromStrPath('/a'), PathSpec.fromStrPath('/bb')]
    const run = async (flags: Record<string, boolean>): Promise<string> => {
      const opts = { stdin: null, flags, cwd: '/' } as unknown as CommandOpts
      const result = await wcGeneric(paths, [], opts, stream, lineCount)
      return new TextDecoder().decode(await materialize(result?.[0] ?? null))
    }
    expect(await run({ lines: true })).toBe('    5 /a\n12345 /bb\n12350 total\n')
    expect(reads).toEqual(['/bb'])
    await run({ lines: true, words: true })
    expect(reads).toEqual(['/bb', '/a', '/bb'])
  })
})

describe('wc takes bytes alone from the size', () => {
  // Mirrors python's test_bytes_alone_come_from_the_size.
  it.each([
    [{ bytes: true }, true, false],
    [{ bytes: true, lines: true }, false, true],
    [{ chars: true }, false, true],
  ])('flags %j', async (flags, sized, read) => {
    const reads: string[] = []
    const asked: string[] = []
    const stream = async function* (p: PathSpec): AsyncIterable<Uint8Array> {
      reads.push(p.virtual)
      await Promise.resolve()
      yield new TextEncoder().encode('abc\n')
    }
    const sizeOf = (p: PathSpec): Promise<number | null> => {
      asked.push(p.virtual)
      return Promise.resolve(4)
    }
    const opts = { stdin: null, flags, cwd: '/' } as unknown as CommandOpts
    await wcGeneric([PathSpec.fromStrPath('/f')], [], opts, stream, undefined, sizeOf)
    expect([asked.length > 0, reads.length > 0]).toEqual([sized, read])
  })

  it('reads a file whose size is unknown', async () => {
    const stream = async function* (): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield new TextEncoder().encode('abcde')
    }
    const opts = {
      stdin: null,
      flags: { bytes: true },
      cwd: '/',
    } as unknown as CommandOpts
    const result = await wcGeneric([PathSpec.fromStrPath('/f')], [], opts, stream, undefined, () =>
      Promise.resolve(null),
    )
    expect(new TextDecoder().decode(await materialize(result?.[0] ?? null))).toBe('5 /f\n')
  })
})
