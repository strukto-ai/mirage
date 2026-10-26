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
import { materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { headGeneric } from './head.ts'

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
