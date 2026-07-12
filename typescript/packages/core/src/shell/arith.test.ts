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
import { evaluateArith } from './arith.ts'
import { ArithError } from './errors.ts'

describe('evaluateArith', () => {
  it('follows precedence', () => {
    expect(evaluateArith('1 + 2 * 3', {}).value).toBe(7n)
    expect(evaluateArith('(1 + 2) * 3', {}).value).toBe(9n)
    expect(evaluateArith('2 ** 3 ** 2', {}).value).toBe(512n)
  })

  it('truncates division and modulo toward zero like C', () => {
    expect(evaluateArith('-7 / 2', {}).value).toBe(-3n)
    expect(evaluateArith('7 / -2', {}).value).toBe(-3n)
    expect(evaluateArith('-7 % 2', {}).value).toBe(-1n)
    expect(evaluateArith('7 % -2', {}).value).toBe(1n)
  })

  it('parses hex and octal literals', () => {
    expect(evaluateArith('0x10', {}).value).toBe(16n)
    expect(evaluateArith('010', {}).value).toBe(8n)
    expect(() => evaluateArith('08', {})).toThrow(ArithError)
  })

  it('records assignments as updates', () => {
    expect(evaluateArith('y = 3, y + 2', {})).toEqual({ value: 5n, updates: { y: '3' } })
    expect(evaluateArith('v += 9', { v: '1' })).toEqual({ value: 10n, updates: { v: '10' } })
  })

  it('handles increments and decrements', () => {
    expect(evaluateArith('i++', {})).toEqual({ value: 0n, updates: { i: '1' } })
    expect(evaluateArith('++i', { i: '1' })).toEqual({ value: 2n, updates: { i: '2' } })
    expect(evaluateArith('i--', { i: '5' })).toEqual({ value: 5n, updates: { i: '4' } })
  })

  it('short-circuits side effects', () => {
    expect(evaluateArith('0 && (q = 7)', {})).toEqual({ value: 0n, updates: {} })
    expect(evaluateArith('1 || (q = 7)', {})).toEqual({ value: 1n, updates: {} })
  })

  it('evaluates only the taken ternary arm', () => {
    expect(evaluateArith('1 ? (w = 4) : (w = 9)', {})).toEqual({ value: 4n, updates: { w: '4' } })
    expect(evaluateArith('5 > 3 ? 10 : 20', {}).value).toBe(10n)
  })

  it('resolves variables recursively like bash', () => {
    expect(evaluateArith('x + 1', {}).value).toBe(1n)
    expect(evaluateArith('s * 2', { s: '1+2' }).value).toBe(6n)
    expect(evaluateArith('z + 1', { z: '' }).value).toBe(1n)
  })

  it('normalizes logical and comparison results to 0/1', () => {
    expect(evaluateArith('3 && 4', {}).value).toBe(1n)
    expect(evaluateArith('!5', {}).value).toBe(0n)
    expect(evaluateArith('2 == 2', {}).value).toBe(1n)
    expect(evaluateArith('2 != 2', {}).value).toBe(0n)
  })

  it('supports bitwise operators and shifts', () => {
    expect(evaluateArith('6 & 3', {}).value).toBe(2n)
    expect(evaluateArith('6 | 3', {}).value).toBe(7n)
    expect(evaluateArith('6 ^ 3', {}).value).toBe(5n)
    expect(evaluateArith('~0', {}).value).toBe(-1n)
    expect(evaluateArith('1 << 4', {}).value).toBe(16n)
    expect(evaluateArith('-16 >> 2', {}).value).toBe(-4n)
  })

  it('wraps at 64 bits', () => {
    expect(evaluateArith('(1 << 63) - 1 + 1', {}).value).toBe(-(1n << 63n))
  })

  it('raises ArithError on bad input', () => {
    expect(() => evaluateArith('1 / 0', {})).toThrow(ArithError)
    expect(() => evaluateArith('2 ** -1', {})).toThrow(ArithError)
    expect(() => evaluateArith('1 +', {})).toThrow(ArithError)
    expect(() => evaluateArith('@', {})).toThrow(ArithError)
    expect(() => evaluateArith('r + 1', { r: 'r + 1' })).toThrow(ArithError)
  })

  it('treats an empty expression as zero', () => {
    expect(evaluateArith('', {})).toEqual({ value: 0n, updates: {} })
  })
})
