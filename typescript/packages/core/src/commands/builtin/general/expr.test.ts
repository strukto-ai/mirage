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
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_EXPR } from './expr.ts'

const DEC = new TextDecoder()

async function runExpr(texts: string[]): Promise<{ out: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = GENERAL_EXPR[0]
  if (cmd === undefined) throw new Error('expr not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('expr', () => {
  it('arithmetic: 2 + 3', async () => {
    expect(await runExpr(['2', '+', '3'])).toEqual({ out: '5\n', exitCode: 0 })
  })

  it('arithmetic: 10 - 4', async () => {
    expect(await runExpr(['10', '-', '4'])).toEqual({ out: '6\n', exitCode: 0 })
  })

  it('arithmetic: 6 * 7', async () => {
    expect(await runExpr(['6', '*', '7'])).toEqual({ out: '42\n', exitCode: 0 })
  })

  it('arithmetic: 20 / 3 truncates', async () => {
    expect(await runExpr(['20', '/', '3'])).toEqual({ out: '6\n', exitCode: 0 })
  })

  it('arithmetic: 10 % 3', async () => {
    expect(await runExpr(['10', '%', '3'])).toEqual({ out: '1\n', exitCode: 0 })
  })

  it('zero result exits 1', async () => {
    expect(await runExpr(['2', '-', '2'])).toEqual({ out: '0\n', exitCode: 1 })
  })

  it('numeric comparison: 5 > 3', async () => {
    expect(await runExpr(['5', '>', '3'])).toEqual({ out: '1\n', exitCode: 0 })
  })

  it('numeric comparison: 2 = 5', async () => {
    expect(await runExpr(['2', '=', '5'])).toEqual({ out: '0\n', exitCode: 1 })
  })

  it('string comparison: abc != xyz', async () => {
    expect(await runExpr(['abc', '!=', 'xyz'])).toEqual({ out: '1\n', exitCode: 0 })
  })

  it('regex match returns length', async () => {
    expect(await runExpr(['helloworld', ':', 'hello'])).toEqual({ out: '5\n', exitCode: 0 })
  })

  it('regex match with capture group (JS-style parens)', async () => {
    // Python expr uses POSIX BRE where \( is the group; JS regex uses
    // bare parens instead. We use JS regex semantics (no \\ needed).
    const r = await runExpr(['filename.txt', ':', '(.*)\\.txt'])
    expect(r.out).toBe('filename\n')
    expect(r.exitCode).toBe(0)
  })

  it('invalid usage exits 2', async () => {
    expect((await runExpr([])).exitCode).toBe(2)
  })
})
