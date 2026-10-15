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
import { efbig } from '../../../errors/fs.ts'
import { materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
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
    const opts = { stdin: ready(), flags: { lines }, cwd: '/', vfs: {}, signal: abort.signal }
    const result = await headGeneric(
      [],
      [],
      opts as CommandOpts,
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

  // A lazy output's timeout leaves the signal alone, so a count inside one
  // whole read checks the invocation's deadline itself.
  it('-n -K stops at the command deadline', async () => {
    const opts = {
      stdin: new TextEncoder().encode('\n'.repeat(20_000_000)),
      flags: { lines: '-20000000' },
      cwd: '/',
      vfs: {},
      timeoutSeconds: 0.02,
      command: 'head',
    }
    const result = await headGeneric(
      [],
      [],
      opts as CommandOpts,
      () => Promise.reject(new Error('stdin only')),
      () => resolveSource(null),
    )
    const [stdout] = result ?? [null]
    const start = performance.now()
    await expect(materialize(stdout)).rejects.toMatchObject({ name: 'CommandTimeoutError' })
    expect(performance.now() - start).toBeLessThan(1000)
  })

  // A backend head calls the scan without the factory's guard, so a pull that
  // stalls must still lose to the abort, and its late line must not print.
  it.each([{ lines: '1' }, { bytes: '1' }])(
    '%o ends a stalled pull at the abort',
    async (flags) => {
      const abort = new AbortController()
      const opts = { stdin: stalled(), flags, cwd: '/', vfs: {}, signal: abort.signal }
      const result = await headGeneric(
        [],
        [],
        opts as CommandOpts,
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

function opts(flags: Record<string, string | boolean>): CommandOpts {
  return { stdin: null, flags, cwd: '/', vfs: null } as unknown as CommandOpts
}

const fileStat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE }))

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
      opts(flags),
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
      opts({ lines: '2' }),
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
      { ...opts({ lines: '1' }), stdin: ENC.encode('in\nmore\n') } as unknown as CommandOpts,
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
      opts({ lines: '1' }),
      fileStat,
      // eslint-disable-next-line require-yield
      async function* () {
        await Promise.resolve()
        throw new Error('read a file')
      },
      (p) =>
        p.virtual === '/big' ? Promise.reject(efbig(p)) : Promise.resolve(ENC.encode('ok\n')),
    )
    expect(DEC.decode(await materialize(result?.[0] ?? null))).toBe(
      '==> /big <==\n\n==> /small <==\nok\n',
    )
    expect(result?.[1].exitCode).toBe(1)
    expect(DEC.decode(await materialize(result?.[1].stderr ?? null))).toBe(
      "head: error reading '/big': File too large\n",
    )
  })
})

it('accepts streamed firstLines and closes an abandoned shortcut', async () => {
  let closed = false
  let read = false
  async function* source(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    try {
      yield ENC.encode('a\n')
      yield ENC.encode('b\n')
      throw new Error('unused shortcut tail was read')
    } finally {
      closed = true
    }
  }
  const result = await headGeneric(
    [PathSpec.fromStrPath('/t')],
    [],
    { stdin: null, flags: { lines: '2' }, cwd: '/', vfs: {} } as CommandOpts,
    (p) => Promise.resolve(new FileStat({ name: p.virtual, type: FileType.FILE })),
    async function* fallback() {
      read = true
      yield await Promise.resolve(ENC.encode('unused'))
    },
    () => Promise.resolve(source()),
  )
  const [out] = result ?? [null]
  const iterator = (out as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(ENC.encode('a\n'))
  await iterator.return?.()
  expect(closed).toBe(true)
  expect(read).toBe(false)
})
