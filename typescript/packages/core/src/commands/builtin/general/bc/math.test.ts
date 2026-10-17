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
import type { MathInterval } from './types.ts'
import { callFunction, settleInterval } from './math.ts'
import { renderNumber } from './render.ts'

describe('bc small math arguments', () => {
  for (const scale of [0, 1, 20, 100]) {
    for (const sign of [-1n, 1n]) {
      for (const name of ['s', 'a', 'c']) {
        it(`${name} truncates a correction at scale ${String(scale)}, sign ${String(sign)}`, () => {
          const result = callFunction(name, { coefficient: sign, scale }, scale)
          const expected = name === 'c' && scale > 0 ? '.' + '9'.repeat(scale) : '0'
          expect(renderNumber(result, 10)).toBe(expected)
        })
      }
    }
  }
})

describe('bc math boundaries', () => {
  for (const scale of [0, 1, 20, 100]) {
    for (const sign of [-1n, 1n]) {
      it(`settles arguments around a quantum at scale ${String(scale)}, sign ${String(sign)}`, () => {
        const quantum = 10n ** BigInt(scale)
        for (const [coefficient, extra] of [
          [0n, 0],
          [1n, 1],
          [999n, 3],
          [1001n, 3],
          [2n, 0],
        ] satisfies [bigint, number][]) {
          const arg = { coefficient: sign * coefficient, scale: scale + extra }
          for (const name of ['s', 'a', 'c']) {
            let expected: bigint
            if (coefficient === 0n) expected = name === 'c' ? quantum : 0n
            else if (name === 'c') expected = scale === 0 ? 0n : quantum - 1n
            else if (coefficient === 2n)
              expected = sign * (scale === 0 ? (name === 'a' ? 1n : 0n) : 1n)
            else if (coefficient === 1001n && scale >= 20) expected = sign
            else expected = 0n
            expect(callFunction(name, arg, scale).coefficient).toBe(expected)
          }
        }
      })
    }
    it(`computes exp and log near one at scale ${String(scale)}`, () => {
      const quantum = 10n ** BigInt(scale)
      expect(callFunction('e', { coefficient: -1n, scale }, scale).coefficient).toBe(
        scale === 0 ? 0n : quantum - 1n,
      )
      expect(callFunction('l', { coefficient: quantum + 1n, scale }, scale).coefficient).toBe(0n)
    })
  }
  for (const sign of [-1n, 1n]) {
    it(`settles open grid endpoints, sign ${String(sign)}`, () => {
      const interval: MathInterval = {
        lower: { coefficient: sign > 0n ? 9n : -10n, scale: 0 },
        upper: { coefficient: sign > 0n ? 10n : -9n, scale: 0 },
        lowerOpen: sign < 0n,
        upperOpen: sign > 0n,
      }
      expect(settleInterval(interval, 0)).toEqual({ coefficient: sign * 9n, scale: 0 })
      expect(settleInterval({ ...interval, lowerOpen: false, upperOpen: false }, 0)).toBeUndefined()
      const lower = { coefficient: sign > 0n ? 91n : -99n, scale: 1 }
      const upper = { coefficient: sign > 0n ? 99n : -91n, scale: 1 }
      expect(settleInterval({ lower, upper, lowerOpen: true, upperOpen: true }, 0)).toEqual({
        coefficient: sign * 9n,
        scale: 0,
      })
    })
  }
  for (const name of ['s', 'a', 'c']) {
    it(`${name} settles tiny input before working precision`, () => {
      expect(callFunction(name, { coefficient: 1n, scale: 16000 }, 100).coefficient).toBe(
        name === 'c' ? 10n ** 100n - 1n : 0n,
      )
    })
  }
  for (const name of ['s', 'a', 'c', 'l', 'e']) {
    it(`${name} settles exact identities before working precision`, () => {
      const arg =
        name === 'l'
          ? { coefficient: 10n ** 5000n, scale: 5000 }
          : { coefficient: 0n, scale: 16000 }
      expect(callFunction(name, arg, 100).coefficient).toBe(
        name === 'c' || name === 'e' ? 10n ** 100n : 0n,
      )
    })
  }
})

describe('bc math working limits', () => {
  for (const [name, arg] of [
    ['s', { coefficient: 10n ** 1499n + 1n, scale: 1500 }],
    ['c', { coefficient: 10n ** 2099n + 1n, scale: 2100 }],
    ['l', { coefficient: 10n ** 2300n + 1n, scale: 2300 }],
    ['e', { coefficient: 10n ** 5000n, scale: 0 }],
  ] satisfies [string, { coefficient: bigint; scale: number }][]) {
    it(`${name} refuses excessive working precision`, () => {
      expect(() => callFunction(name, arg, 100)).toThrow('Arithmetic limit exceeded')
    })
  }
})

for (const [coefficient, scale, expected] of [
  [
    '1',
    20,
    '-460517018598809136803598290936872841520220297725754595206665580193514521935470496047199441017919659668',
  ],
  [
    '1',
    40,
    '-921034037197618273607196581873745683040440595451509190413331160387029043870940992094398882035839319336',
  ],
  [
    '46511',
    48,
    '-997766403409746616629445553439376448559279753222656842613015918479959801357470111011200235139937215531',
  ],
] satisfies [string, number, string][]) {
  it(`preserves logarithm precision for ${coefficient} at scale ${String(scale)}`, () => {
    const result = callFunction('l', { coefficient: BigInt(coefficient), scale }, 100)
    expect(String(result.coefficient)).toBe(expected)
  })
}
