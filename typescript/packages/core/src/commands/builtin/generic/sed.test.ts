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

import { yieldBytes } from '../../../io/stream.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { eisdir } from '../../../errors/fs.ts'
import type { Context } from '../../config.ts'
import { sedGeneric } from './sed.ts'

const DEC = new TextDecoder()

async function runSed(
  texts: string[],
  flags: Context['flags'] = {},
): Promise<{ exitCode: number; stderr: string }> {
  const ctx = {
    stdin: null,
    flags,
    cwd: PathSpec.fromStrPath('/'),
    vfs: { kind: 'ram' } as never,
  } as Context
  const result = await sedGeneric(
    [],
    texts,
    ctx,
    () => {
      throw new Error('no operands; nothing to stream')
    },
    () => Promise.resolve(),
  )
  if (result === null) throw new Error('sed returned nothing')
  const io = result[1]
  const stderr = io.stderr === null ? '' : DEC.decode(await materialize(io.stderr))
  return { exitCode: io.exitCode, stderr }
}

describe('sed usage reporting', () => {
  it('reports no input files for -i with no operands', async () => {
    expect(await runSed(['s/a/b/'], { i: true })).toEqual({
      exitCode: 4,
      stderr: 'sed: no input files\n',
    })
  })
})

it('closes primed input when an in-place write is refused', async () => {
  let closed = false
  const error = new Error('write refused')
  await expect(
    sedGeneric(
      [PathSpec.fromStrPath('/a.txt')],
      ['s/one/two/'],
      {
        stdin: null,
        flags: { i: true },
        cwd: PathSpec.fromStrPath('/'),
        dispatch: () => Promise.reject(error),
      } as Context,
      async function* () {
        try {
          await Promise.resolve()
          yield new TextEncoder().encode('one\n')
          throw new Error('refused write must not pull more input')
        } finally {
          closed = true
        }
      },
      () => Promise.resolve(),
    ),
  ).rejects.toBe(error)
  expect(closed).toBe(true)
})

describe('sed operands after a directory (GNU sed 4.9)', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

  async function run(
    script: string,
    flags: Context['flags'] = {},
  ): Promise<{ out: string; code: number; reads: string[] }> {
    const files = new Map([
      ['/f', enc('one\ntwo\nthree\n')],
      ['/g', enc('L1\nL2\n')],
    ])
    const reads: string[] = []
    const paths = ['/f', '/d', '/g'].map((p) => PathSpec.fromStrPath(p))
    const ctx = {
      stdin: null,
      flags: { n: true, ...flags },
      cwd: PathSpec.fromStrPath('/'),
      vfs: { kind: 'ram' } as never,
    } as Context
    const result = await sedGeneric(
      paths,
      [script],
      ctx,
      async function* (p) {
        await Promise.resolve()
        reads.push(p.virtual)
        if (p.virtual === '/d') throw eisdir(p)
        yield* yieldBytes(files.get(p.virtual) ?? new Uint8Array())
      },
      () => Promise.resolve(),
    )
    if (result === null) throw new Error('sed returned nothing')
    const out = result[0] === null ? '' : DEC.decode(await materialize(result[0]))
    return { out, code: result[1].exitCode, reads }
  }

  // Under -s the lookahead stays in the file; without one nothing past the
  // directory is read either way.
  it.each([
    ['n;p', { separate: true }, 'two\n'],
    ['p', {}, 'one\ntwo\nthree\n'],
  ])('reads nothing past the directory for %s', async (script, flags, out) => {
    expect(await run(script, flags)).toEqual({ out, code: 4, reads: ['/f', '/d'] })
  })
})

it.each([
  ['w /saved', 0],
  ['w /saved\nq7', 7],
] as const)(
  'finalizes reached writes and status when %s output closes early',
  async (script, code) => {
    const files = new Map<string, Uint8Array>()
    const result = await sedGeneric(
      [],
      [script],
      {
        stdin: new TextEncoder().encode('x\n'),
        flags: {},
        cwd: PathSpec.fromStrPath('/'),
      } as Context,
      () => yieldBytes(new Uint8Array()),
      async (p, data) => {
        files.set(p.virtual, await materialize(data))
      },
    )
    if (result === null) throw new Error('no result')
    const output = result[0] as AsyncGenerator<Uint8Array, void>
    expect(await output.next()).toEqual({ done: false, value: new TextEncoder().encode('x\n') })
    await output.return(undefined)
    expect(DEC.decode(files.get('/saved'))).toBe('x\n')
    expect(result[1].exitCode).toBe(code)
  },
)

it('shares bytes-valued stdin across repeated operands', async () => {
  const dash = new PathSpec({ virtual: '-', directory: '-', vfsPath: '-', rawPath: '-' })
  const result = await sedGeneric(
    [dash, dash],
    [''],
    {
      stdin: new TextEncoder().encode('x\n'),
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
    } as Context,
    () => yieldBytes(new Uint8Array()),
    () => Promise.resolve(),
  )
  if (result === null) throw new Error('no result')
  expect(DEC.decode(await materialize(result[0]))).toBe('x\n')
  expect(result[1].exitCode).toBe(0)
})
