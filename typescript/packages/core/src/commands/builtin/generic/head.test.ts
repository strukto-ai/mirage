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
import { eacces, efbig } from '../../../errors/fs.ts'
import { ensureStream } from '../../../io/stream.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { headGeneric as generic, parseFlags } from './head.ts'

type Operands<T> = T extends [unknown, ...infer R] ? R : never

// head as its builder runs it: the options read first, a refusal returned.
async function headGeneric(
  ...args: Operands<Parameters<typeof generic>>
): Promise<CommandFnResult> {
  const parsed = parseFlags(args[2].flags)
  if (parsed instanceof IOResult) return [null, parsed]
  return generic(parsed, ...args)
}

// A first pull that stalls for 2 s, then returns a line.
async function* stalled(): AsyncIterable<Uint8Array> {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  yield new TextEncoder().encode('late\n')
}

describe('headGeneric line counts', () => {
  // Every pull is ready and no line ends, so only the scan's own checkpoint
  // lets the abort timer run.
  it.each([
    ['1', 'x'],
    ['1', ''],
    ['-1', 'x'],
    ['-1', ''],
  ])('-n %s lets an abort into a ready input of %j pulls', async (lines, piece) => {
    const bytes = new TextEncoder().encode(piece)
    async function* ready(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < 2_000_000; i++) {
        await Promise.resolve()
        yield bytes
      }
    }
    const abort = new AbortController()
    const ctx = {
      stdin: ready(),
      flags: { lines },
      cwd: PathSpec.fromStrPath('/'),
      signal: abort.signal,
    }
    const result = await headGeneric(
      [],
      [],
      ctx as Context,
      () => Promise.reject(new Error('stdin only')),
      () => resolveSource(null),
    )
    const [stdout] = result ?? [null]
    const timer = setTimeout(() => {
      abort.abort()
    }, 5)
    try {
      await expect(materialize(stdout)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(timer)
    }
  })

  // A backend head calls the scan without the factory's guard, so a pull that
  // stalls must still lose to the abort, and its late line must not print.
  it.each([{ lines: '1' }, { bytes: '1' }])(
    '%o ends a stalled pull at the abort',
    async (flags) => {
      const abort = new AbortController()
      const ctx = { stdin: stalled(), flags, cwd: PathSpec.fromStrPath('/'), signal: abort.signal }
      const result = await headGeneric(
        [],
        [],
        ctx as Context,
        () => Promise.reject(new Error('stdin only')),
        () => resolveSource(null),
      )
      const [stdout] = result ?? [null]
      const start = performance.now()
      const timer = setTimeout(() => {
        abort.abort()
      }, 5)
      try {
        await expect(materialize(stdout)).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        clearTimeout(timer)
      }
      expect(performance.now() - start).toBeLessThan(1000)
    },
  )
})

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function ctx(flags: Record<string, string | boolean>): Context {
  return { stdin: null, flags, cwd: PathSpec.fromStrPath('/') } as Context
}

const fileStat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE }))

const firstLinesOrFail = (p: PathSpec): Promise<Uint8Array> => {
  if (p.virtual === '/big') return Promise.reject(efbig(p))
  if (p.virtual === '/locked') return Promise.reject(eacces(p))
  return Promise.resolve(ENC.encode('ok\n'))
}

describe('headGeneric over chunks', () => {
  async function headOf(parts: string[], lines: string): Promise<string[]> {
    async function* source(): AsyncIterable<Uint8Array> {
      for (const part of parts) {
        await Promise.resolve()
        yield ENC.encode(part)
      }
    }
    const ctx = { stdin: source(), flags: { lines }, cwd: PathSpec.fromStrPath('/') }
    const result = await headGeneric(
      [],
      [],
      ctx as Context,
      () => Promise.reject(new Error('stdin only')),
      () => resolveSource(null),
    )
    const [stdout] = result ?? [null]
    const pieces: string[] = []
    for await (const piece of stdout as AsyncIterable<Uint8Array>) pieces.push(DEC.decode(piece))
    return pieces
  }

  // A piece per line costs a pipe a turn of the loop per line.
  it.each(['3', '-2'])('-n %s writes what it keeps of a chunk in one piece', async (lines) => {
    expect(await headOf(['1\n2\n', '3\n4\n5\n'], lines)).toEqual(['1\n2\n', '3\n'])
  })

  it.each([
    [['a\nb\nc'], '-1', 'a\nb\n'],
    [['a\nb\n', 'c\n', 'd'], '-2', 'a\nb\n'],
    [['a\nb\n', 'c\n', 'd\n'], '-1', 'a\nb\nc\n'],
  ])('%j -n %s', async (parts, lines, expected) => {
    expect((await headOf(parts, lines)).join('')).toBe(expected)
  })
})

// Mirrors the head_generic cases in test_head.py.
describe('head asks the mount for the first lines', () => {
  it.each([
    [{}, 10],
    [{ lines: '2' }, 2],
    [{ lines: '0' }, null],
    [{ lines: '-1' }, null],
    [{ bytes: '3' }, null],
    [{ lines: '2', zero_terminated: true }, null],
  ] as const)('with %j asks for %s', async (flags, asked) => {
    const reads: string[] = []
    const calls: number[] = []
    const result = await headGeneric(
      [PathSpec.fromStrPath('/t')],
      [],
      ctx(flags),
      fileStat,
      async function* (p) {
        reads.push(p.virtual)
        await Promise.resolve()
        yield ENC.encode('x\ny\nz\n')
      },
      (_p, n) => {
        calls.push(n)
        return Promise.resolve(ENC.encode('a\nb\n'))
      },
    )
    const data = DEC.decode(await materialize(result?.[0] ?? null))
    expect(calls).toEqual(asked === null ? [] : [asked])
    if (asked !== null) expect([data, reads]).toEqual(['a\nb\n', []])
  })

  it('reads a file the mount leaves to the read', async () => {
    const reads: string[] = []
    const result = await headGeneric(
      [PathSpec.fromStrPath('/t')],
      [],
      ctx({ lines: '2' }),
      fileStat,
      async function* (p) {
        reads.push(p.virtual)
        await Promise.resolve()
        yield ENC.encode('x\ny\nz\n')
      },
      () => Promise.resolve(null),
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe('x\ny\n')
    expect(reads).toEqual(['/t'])
  })

  it('reads standard input without asking the first lines', async () => {
    const result = await headGeneric(
      [PathSpec.fromStrPath('-')],
      [],
      { ...ctx({ lines: '1' }), stdin: ENC.encode('in\nmore\n') } as unknown as Context,
      fileStat,
      // eslint-disable-next-line require-yield
      async function* () {
        await Promise.resolve()
        throw new Error('read a file')
      },
      (p) => Promise.reject(new Error(`asked firstLines of ${p.virtual}`)),
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe('in\n')
    expect(result?.[1].exitCode).toBe(0)
  })

  it('reports a failed operand and prints the next', async () => {
    const result = await headGeneric(
      [PathSpec.fromStrPath('/big'), PathSpec.fromStrPath('/small')],
      [],
      ctx({ lines: '1' }),
      fileStat,
      // eslint-disable-next-line require-yield
      async function* () {
        await Promise.resolve()
        throw new Error('read a file')
      },
      firstLinesOrFail,
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe(
      '==> /big <==\n\n==> /small <==\nok\n',
    )
    expect(result?.[1].exitCode).toBe(1)
    expect(DEC.decode(await materialize(result?.[1].stderr ?? null))).toBe(
      "head: error reading '/big': File too large\n",
    )
  })

  it.each([
    [['/locked', '/small'], '==> /small <==\nok\n'],
    [['/small', '/locked', '/small'], '==> /small <==\nok\n\n==> /small <==\nok\n'],
  ])('prints no header for an operand it may not open: %j', async (names, expected) => {
    const result = await headGeneric(
      names.map((name) => PathSpec.fromStrPath(name)),
      [],
      ctx({ lines: '1' }),
      fileStat,
      // eslint-disable-next-line require-yield
      async function* () {
        await Promise.resolve()
        throw new Error('read a file')
      },
      firstLinesOrFail,
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe(expected)
    expect(result?.[1].exitCode).toBe(1)
    expect(DEC.decode(await materialize(result?.[1].stderr ?? null))).toBe(
      "head: cannot open '/locked' for reading: Permission denied\n",
    )
  })

  it.each([
    ['/big', '==> /big <==\n', "head: error reading '/big': File too large\n"],
    ['/locked', '', "head: cannot open '/locked' for reading: Permission denied\n"],
  ])(
    '-v keeps one failure when the reader stops at the header: %s',
    async (name, header, stderr) => {
      const result = await headGeneric(
        [PathSpec.fromStrPath(name)],
        [],
        ctx({ lines: '1', verbose: true }),
        fileStat,
        // eslint-disable-next-line require-yield
        async function* () {
          await Promise.resolve()
          throw new Error('read a file')
        },
        firstLinesOrFail,
      )
      const out = ensureStream(result?.[0] ?? new Uint8Array())[Symbol.asyncIterator]()
      const first = await out.next()
      await out.return?.()
      expect(first.done === true ? '' : DEC.decode(first.value)).toBe(header)
      expect(result?.[1].exitCode).toBe(1)
      expect(DEC.decode(await materialize(result?.[1].stderr ?? null))).toBe(stderr)
    },
  )
})

// Mirrors test_head.py: mirage-rs reads -n and -c before any operand, and a
// refusal is head's stderr and exit 1.
describe('head refuses a count before reading any operand', () => {
  it.each([
    [{ lines: 'x' }, "head: invalid number of lines: 'x'\n"],
    [{ lines: '2K' }, "head: invalid number of lines: '2K'\n"],
    [{ bytes: '1y' }, "head: invalid number of bytes: '1y'\n"],
  ])('%j', (flags, stderr) => {
    const parsed = parseFlags(flags)
    if (!(parsed instanceof IOResult)) throw new Error('head read a refused count')
    expect([parsed.exitCode, DEC.decode(parsed.stderr as Uint8Array)]).toEqual([1, stderr])
  })

  it('reads -c with its size suffix', () => {
    const parsed = parseFlags({ bytes: '-2k', lines: '3' })
    if (parsed instanceof IOResult) throw new Error('head refused a count')
    expect([parsed.lines, parsed.bytesMode]).toEqual([3, -2048])
  })
})
