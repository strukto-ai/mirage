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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { eisdir } from '../../../errors/fs.ts'
import type { Context } from '../../config.ts'
import type { FlagValue } from '../../spec/types.ts'
import { sedGeneric, sedWrites } from './sed.ts'
import { Files } from '../../../workspace/files.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function noRead(p: PathSpec): AsyncIterable<Uint8Array> {
  throw new Error(`read ${p.virtual}`)
}

describe('sed usage reporting', () => {
  it('reports no input files for -i with no operands', async () => {
    const ctx = { stdin: null, flags: { i: true }, cwd: PathSpec.fromStrPath('/') } as Context
    const result = await sedGeneric([], ['s/a/b/'], ctx, noRead)
    if (result === null) throw new Error('sed returned nothing')
    if (result[0] !== null) await materialize(result[0])
    const io = result[1]
    expect(io.exitCode).toBe(4)
    expect(DEC.decode(await materialize(io.stderr))).toBe('sed: no input files\n')
  })
})

describe('sedWrites', () => {
  it.each<[Record<string, FlagValue>, string[], boolean]>([
    [{}, ['p'], false],
    [{}, ['w /o'], true],
    [{}, ['s/a/b/w /dev/stdout'], true],
    [{ e: ['w /o', 'k'] }, [], true],
    [{ e: ['k', 'w /o'] }, [], false],
    [{ i: true }, ['p'], true],
    [{}, [], false],
  ])('%j %j writes: %s', (flags, texts, writes) => {
    expect(sedWrites(flags, texts)).toBe(writes)
  })
})

describe('sed operands after a directory (GNU sed 4.9)', () => {
  async function run(
    script: string,
    flags: Context['flags'] = {},
  ): Promise<{ out: string; code: number; reads: string[] }> {
    const files = new Map([
      ['/f', ENC.encode('one\ntwo\nthree\n')],
      ['/g', ENC.encode('L1\nL2\n')],
    ])
    const reads: string[] = []
    const paths = ['/f', '/d', '/g'].map((p) => PathSpec.fromStrPath(p))
    const ctx = {
      stdin: null,
      flags: { n: true, ...flags },
      cwd: PathSpec.fromStrPath('/'),
    } as Context
    const result = await sedGeneric(paths, [script], ctx, async function* (p) {
      await Promise.resolve()
      reads.push(p.virtual)
      if (p.virtual === '/d') throw eisdir(p)
      yield* yieldBytes(files.get(p.virtual) ?? new Uint8Array())
    })
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
    const dispatch = async (
      op: string,
      path: PathSpec,
      args: readonly unknown[] = [],
    ): Promise<[unknown, IOResult]> => {
      const body = await materialize((args[0] ?? new Uint8Array()) as ByteSource)
      const kept =
        op === 'append' ? (files.get(path.virtual) ?? new Uint8Array()) : new Uint8Array()
      files.set(path.virtual, new Uint8Array([...kept, ...body]))
      return [null, new IOResult()]
    }
    const data = ENC.encode(Array.from({ length: 100000 }, (_, n) => `${String(n)}\n`).join(''))
    const ctx = {
      stdin: data,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      vfs: new Files(dispatch, null, null, { ledger: false }),
    } as Context
    const result = await sedGeneric([], [script], ctx, noRead)
    if (result === null) throw new Error('no result')
    const output = result[0] as AsyncGenerator<Uint8Array, void>
    const first = await output.next()
    await output.return(undefined)
    const saved = DEC.decode(files.get('/saved'))
    expect(DEC.decode(first.value as Uint8Array).startsWith('0\n')).toBe(true)
    expect(DEC.decode(data).startsWith(saved)).toBe(true)
    expect(saved.length).toBeGreaterThanOrEqual((first.value as Uint8Array).byteLength)
    expect(saved.length).toBeLessThan(data.byteLength)
    expect(result[1].exitCode).toBe(code)
  },
)

it('shares bytes-valued stdin across repeated operands', async () => {
  const dash = new PathSpec({ virtual: '-', directory: '-', vfsPath: '-', rawPath: '-' })
  const ctx = { stdin: ENC.encode('x\n'), flags: {}, cwd: PathSpec.fromStrPath('/') } as Context
  const result = await sedGeneric([dash, dash], [''], ctx, noRead)
  if (result === null) throw new Error('no result')
  expect(DEC.decode(await materialize(result[0]))).toBe('x\n')
  expect(result[1].exitCode).toBe(0)
})
