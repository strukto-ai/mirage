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
import { IOResult, materialize, type ByteSource } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import type { OperandRun } from '../types.ts'
import { combineWc } from './wc.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function op(data: string, exitCode = 0): OperandRun {
  const path = '/a/x'
  return {
    scope: new PathSpec({
      virtual: path,
      directory: path,
      resolved: true,
      resourcePath: mountKey(path, ''),
    }),
    data: ENC.encode(data),
    io: new IOResult({ exitCode }),
  }
}

async function text(body: ByteSource | null): Promise<string> {
  if (body === null) return ''
  return DEC.decode(await materialize(body))
}

describe('combineWc', () => {
  it('uses one global column width across runs', async () => {
    const out = await text(
      combineWc([op('100 100 400 /a/big.txt\n'), op('5 5 20 /b/small.txt\n')], {}),
    )
    expect(out).toBe('100 100 400 /a/big.txt\n  5   5  20 /b/small.txt\n105 105 420 total\n')
  })

  it('keeps every row of a glob operand', async () => {
    // runFanout forces --total=never, so a glob operand's run is all file
    // rows; the combine must not treat the last one as a per-run total.
    const out = await text(
      combineWc([op('2 /a/one.txt\n1 /a/two.txt\n'), op('1 /b/three.txt\n')], { lines: true }),
    )
    expect(out).toBe('2 /a/one.txt\n1 /a/two.txt\n1 /b/three.txt\n4 total\n')
  })

  it('maxes max-line-length instead of summing it', async () => {
    const out = await text(combineWc([op('9 /a/x\n'), op('4 /b/y\n')], { max_line_length: true }))
    expect(out.endsWith('9 total\n')).toBe(true)
  })

  it('prints no total row under --total=never', async () => {
    const out = await text(
      combineWc([op('2 3 14 /a/x.txt\n'), op('1 3 15 /b/z.txt\n')], { total: 'never' }),
    )
    expect(out).toBe(' 2  3 14 /a/x.txt\n 1  3 15 /b/z.txt\n')
  })

  it('prints the grand total alone under --total=only', async () => {
    const out = await text(
      combineWc([op('2 3 14 /a/x.txt\n'), op('1 3 15 /b/z.txt\n')], { total: 'only' }),
    )
    expect(out).toBe('3 6 29\n')
  })

  it('prints a total for a single row under --total=always', async () => {
    const out = await text(combineWc([op('2 3 14 /a/x.txt\n')], { total: 'always' }))
    expect(out).toBe(' 2  3 14 /a/x.txt\n 2  3 14 total\n')
  })

  it('omits the total for a single row under auto', async () => {
    const out = await text(combineWc([op('2 3 14 /a/x.txt\n')], {}))
    expect(out).toBe(' 2  3 14 /a/x.txt\n')
  })

  it('still totals when one of two operands failed', async () => {
    // Two operands were given, so GNU prints the total even though only one
    // of them resolved into a row.
    const out = await text(combineWc([op('1 /a/f.txt\n'), op('', 1)], { lines: true }))
    expect(out).toBe('1 /a/f.txt\n1 total\n')
  })

  it('prints nothing when every operand failed', async () => {
    expect(await text(combineWc([op('', 1)], {}))).toBe('')
  })

  it('zeroes the grand total under --total=only when every operand failed', async () => {
    expect(await text(combineWc([op('', 1)], { total: 'only' }))).toBe('0 0 0\n')
  })
})
