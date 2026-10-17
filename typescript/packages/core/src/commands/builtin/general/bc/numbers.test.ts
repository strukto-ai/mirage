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

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import * as constants from './constants.ts'
import { BcRuntimeError } from './errors.ts'
import {
  applyBinary,
  bcLength,
  bcSqrt,
  divide,
  powerTen,
  readBaseNumber,
  rescale,
} from './numbers.ts'
import { evalStatement } from './parser.ts'
import type { BcState } from './types.ts'

function state(scale = 0): BcState {
  return {
    scale,
    mathMode: false,
    ibase: 10,
    obase: 10,
    last: { coefficient: 0n, scale: 0 },
    variables: new Map(),
    warnings: [],
  }
}

describe('bc resource bounds', () => {
  const powers: [string, string][] = [
    ['1.0^1000000000000', '1.000\n'],
    ['(-1.00)^1000000000001', '-1.000\n'],
    ['0.00^1000000000000', '0\n'],
    ['0^0', '1\n'],
    ['1.0^-1000000000000', '1.000\n'],
    ['(-1.00)^-1000000000001', '-1.000\n'],
    ['.1^1000000000000', '0\n'],
    ['.10^-2', '100.000\n'],
    ['1.2^3', '1.728\n'],
    ['1.2^-3', '.578\n'],
    ['(-1.20)^-3', '-.578\n'],
  ]
  for (const [text, expected] of powers) {
    it(`preserves the original scale of ${text}`, () => {
      const writes: string[] = []
      evalStatement(text, state(3), writes)
      expect(writes.join('')).toBe(expected)
    })
  }

  for (const text of [
    '2^1000000',
    '2^-1000000',
    '2^' + String(10n ** 100n),
    '2^-' + String(10n ** 100n),
    '.1^-10000000000000000000000000000000000',
    '2^32768*2^32768',
    '1'.repeat(constants.MAX_LITERAL_DIGITS + 1),
    '.' + '0'.repeat(constants.MAX_LITERAL_DIGITS) + '1',
  ]) {
    it(`recovers on the next line after refusing ${text.slice(0, 40)}`, () => {
      const script = `
import { runLines } from ${JSON.stringify(new URL('./command.ts', import.meta.url).href)}
import { parseInput } from ${JSON.stringify(new URL('./lexer.ts', import.meta.url).href)}
import { OutputColumn } from ${JSON.stringify(new URL('./render.ts', import.meta.url).href)}
const state = { scale: 0, mathMode: false, ibase: 10, obase: 10,
  last: { coefficient: 0n, scale: 0 }, variables: new Map(), warnings: [] }
const errors = []
const output = []
for await (const chunk of runLines(
  parseInput(new TextEncoder().encode(process.argv[1] + ';99\\n2+2\\n')),
  state, new OutputColumn(0), errors,
)) output.push(new TextDecoder().decode(chunk))
process.stdout.write(JSON.stringify([errors, output.join('')]))
`
      const output = execFileSync(
        process.execPath,
        [
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '-e',
          script,
          '--',
          text,
        ],
        { encoding: 'utf8', timeout: 5000 },
      )
      expect(JSON.parse(output)).toEqual([
        ['Runtime error (func=(main), adr=3): Arithmetic limit exceeded'],
        '4\n',
      ])
    })
  }

  it('preserves large exact literals and refuses excessive base conversion', () => {
    expect(bcLength(readBaseNumber('1' + '0'.repeat(5000), 10))).toBe(5001)
    expect(readBaseNumber('.' + '0'.repeat(15999) + '1', 10)).toEqual({
      coefficient: 1n,
      scale: 16000,
    })
    expect(readBaseNumber('F'.repeat(16000), 16).coefficient.toString(2).length).toBe(64000)
    expect(() => readBaseNumber('.' + 'F'.repeat(16000), 16)).toThrow(constants.ARITHMETIC_LIMIT)
  })

  it('bounds shifts, division and square-root setup before allocating', () => {
    for (const exponent of [-1, constants.MAX_COEFFICIENT_BITS])
      expect(() => powerTen(exponent)).toThrow(constants.ARITHMETIC_LIMIT)
    expect(powerTen(0)).toBe(1n)
    expect(rescale({ coefficient: 1n, scale: 16000 }, 0)).toEqual({ coefficient: 0n, scale: 0 })
    const huge = { coefficient: 2n ** 32768n, scale: 0 }
    expect(() => applyBinary('*', huge, huge, state())).toThrow(BcRuntimeError)
    expect(() => rescale(huge, 16000)).toThrow(constants.ARITHMETIC_LIMIT)
    expect(() => divide(huge, { coefficient: 1n, scale: 0 }, 16000)).toThrow(
      constants.ARITHMETIC_LIMIT,
    )
    expect(() => bcSqrt({ coefficient: 2n, scale: 0 }, 16000)).toThrow(constants.ARITHMETIC_LIMIT)
  })
})
