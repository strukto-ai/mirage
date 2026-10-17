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

import type { BcNumber, MathInterval } from './types.ts'
import * as constants from './constants.ts'
import { BcRuntimeError } from './errors.ts'
import { ensureBits, powerTen, integerSqrt, integerText, rescale, truncDiv } from './numbers.ts'

export function atanSeries(x: bigint, unit: bigint): bigint {
  const squared = truncDiv(x * x, unit)
  let power = x
  let sum = x
  let denominator = 3n
  let negative = true
  for (;;) {
    power = truncDiv(power * squared, unit)
    const term = truncDiv(power, denominator)
    if (term === 0n) return sum
    sum += negative ? -term : term
    negative = !negative
    denominator += 2n
  }
}

export function pi(unit: bigint): bigint {
  return 16n * atanSeries(unit / 5n, unit) - 4n * atanSeries(unit / 239n, unit)
}

export function bcAtan(x: bigint, unit: bigint): bigint {
  if (x < 0n) return -bcAtan(-x, unit)
  const reciprocal = x > unit
  if (reciprocal) x = truncDiv(unit * unit, x)
  let multiplier = 1n
  while (x > unit / 4n) {
    x = truncDiv(x * unit, unit + integerSqrt(unit * unit + x * x))
    multiplier *= 2n
  }
  const result = atanSeries(x, unit) * multiplier
  return reciprocal ? pi(unit) / 2n - result : result
}

export function bcSin(x: bigint, unit: bigint): bigint {
  const halfTurn = pi(unit)
  x %= 2n * halfTurn
  if (x > halfTurn) x -= 2n * halfTurn
  if (x < -halfTurn) x += 2n * halfTurn
  const squared = x * x
  let term = x
  let sum = x
  for (let n = 2n; ; n += 2n) {
    term = -truncDiv(term * squared, unit * unit * n * (n + 1n))
    if (term === 0n) return sum
    sum += term
  }
}

export function bcCos(x: bigint, unit: bigint): bigint {
  const halfTurn = pi(unit)
  x %= 2n * halfTurn
  if (x > halfTurn) x -= 2n * halfTurn
  if (x < -halfTurn) x += 2n * halfTurn
  const squared = x * x
  let term = unit
  let sum = unit
  for (let n = 1n; ; n += 2n) {
    term = -truncDiv(term * squared, unit * unit * n * (n + 1n))
    if (term === 0n) return sum
    sum += term
  }
}

export function bcLog(x: bigint, unit: bigint): bigint {
  if (x === unit) return 0n
  let multiplier = 2n
  while (x < unit / 2n || x > 2n * unit) {
    x = integerSqrt(x * unit)
    multiplier *= 2n
  }
  const z = truncDiv((x - unit) * unit, x + unit)
  const squared = truncDiv(z * z, unit)
  let power = z
  let sum = z
  for (let denominator = 3n; ; denominator += 2n) {
    power = truncDiv(power * squared, unit)
    const term = truncDiv(power, denominator)
    if (term === 0n) return multiplier * sum
    sum += term
  }
}

export function bcExp(x: bigint, unit: bigint): bigint {
  const negative = x < 0n
  if (negative) x = -x
  let squarings = 0
  while (x > unit / 8n) {
    x /= 2n
    squarings++
  }
  let sum = unit
  let term = unit
  for (let denominator = 1n; ; denominator++) {
    term = truncDiv(term * x, unit * denominator)
    if (term === 0n) break
    sum += term
  }
  for (let n = 0; n < squarings; n++) {
    ensureBits(2 * sum.toString(2).length)
    sum = truncDiv(sum * sum, unit)
  }
  return negative ? truncDiv(unit * unit, sum) : sum
}

export function logDomainValue(scale: number): BcNumber {
  const unit = powerTen(scale)
  ensureBits(2 * unit.toString(2).length)
  return { coefficient: (1n - unit) * unit, scale }
}

export function settleInterval(interval: MathInterval, scale: number): BcNumber | undefined {
  function candidate(endpoint: BcNumber, opened: boolean, lower: boolean): bigint {
    let result = rescale(endpoint, scale).coefficient
    const onGrid =
      endpoint.scale <= scale || endpoint.coefficient % powerTen(endpoint.scale - scale) === 0n
    if (opened && onGrid) {
      if (lower && endpoint.coefficient < 0n) result += 1n
      else if (!lower && endpoint.coefficient > 0n) result -= 1n
    }
    return result
  }
  const lower = candidate(interval.lower, interval.lowerOpen, true)
  const upper = candidate(interval.upper, interval.upperOpen, false)
  return lower === upper ? { coefficient: lower, scale } : undefined
}

export function smallResult(name: string, arg: BcNumber, scale: number): BcNumber | undefined {
  if (!['s', 'a', 'c'].includes(name)) return undefined
  const magnitude = arg.coefficient < 0n ? -arg.coefficient : arg.coefficient
  const digits = integerText(magnitude)
  const shift = arg.scale - scale
  const tiny =
    shift >= 0 &&
    (digits.length <= shift || (digits.length === shift + 1 && digits === '1' + '0'.repeat(shift)))
  if (tiny) return { coefficient: name === 'c' ? powerTen(scale) - 1n : 0n, scale }
  if (
    (digits.length > arg.scale && !(magnitude === 1n && arg.scale === 0)) ||
    arg.scale > Math.floor(constants.MAX_WORKING_SCALE / 3)
  )
    return undefined
  const order = name === 'c' ? 2 : 3
  const endpointScale = order * arg.scale
  ensureBits(order * magnitude.toString(2).length + 4)
  const power = magnitude ** BigInt(order)
  const divisor = name === 'c' ? 2n : name === 's' ? 6n : 3n
  const correction = power / divisor
  const remainder = power % divisor
  const upper =
    name === 'c' ? powerTen(endpointScale) : magnitude * powerTen(endpointScale - arg.scale)
  const lower = upper - correction - (remainder === 0n ? 0n : 1n)
  const interval: MathInterval =
    name !== 'c' && arg.coefficient < 0n
      ? {
          lower: { coefficient: -upper, scale: endpointScale },
          upper: { coefficient: -lower, scale: endpointScale },
          lowerOpen: true,
          upperOpen: remainder === 0n,
        }
      : {
          lower: { coefficient: lower, scale: endpointScale },
          upper: { coefficient: upper, scale: endpointScale },
          lowerOpen: remainder === 0n,
          upperOpen: true,
        }
  return settleInterval(interval, scale)
}

// GNU bc 1.07.1 can lose final digits through intermediate math truncation,
// especially for large trigonometric arguments. These guards reduce that error;
// the general kernels do not certify the final digit.
export function workingScale(name: string, arg: BcNumber, scale: number): number {
  const magnitude = arg.coefficient < 0n ? -arg.coefficient : arg.coefficient
  const integerDigits = Math.max(0, integerText(magnitude).length - arg.scale)
  let working = Math.max(scale, arg.scale) + 16
  if (name === 's' || name === 'a' || name === 'c')
    working = Math.max(working, (name === 'c' ? 2 : 3) * arg.scale + 16)
  if (name === 'e' || name === 'l') working = Math.max(working, 2 * arg.scale + 16)
  if (name === 'l') working = Math.max(working, scale + arg.scale + 16)
  if (name === 's' || name === 'c') working += integerDigits
  else if (name === 'e') {
    const integer = rescale(arg, 0).coefficient
    if ((integer < 0n ? -integer : integer) > BigInt(2 * constants.MAX_WORKING_SCALE))
      throw new BcRuntimeError(constants.ARITHMETIC_LIMIT)
    working += Number(integer < 0n ? -integer / 2n : integer / 2n)
  }
  if (working > constants.MAX_WORKING_SCALE) throw new BcRuntimeError(constants.ARITHMETIC_LIMIT)
  ensureBits(
    constants.DECIMAL_DIGIT_BITS * working * constants.SERIES_PRODUCT_FACTORS +
      constants.SERIES_LOOP_BITS,
  )
  return working
}

export function callFunction(name: string, arg: BcNumber, scale: number): BcNumber {
  if (arg.coefficient === 0n) {
    if (name === 'l') return logDomainValue(scale)
    return { coefficient: name === 'c' || name === 'e' ? powerTen(scale) : 0n, scale }
  }
  const digits = integerText(arg.coefficient < 0n ? -arg.coefficient : arg.coefficient)
  const trailing = Math.min(arg.scale, digits.length - digits.replace(/0+$/, '').length)
  if (trailing > 0) arg = rescale(arg, arg.scale - trailing)
  if (name === 'l' && arg.coefficient === 1n && arg.scale === 0) return { coefficient: 0n, scale }
  if (name === 'l' && arg.coefficient < 0n) return logDomainValue(scale)
  if (name === 'e' && rescale(arg, 0).coefficient < BigInt(-3 * (scale + 16)))
    return { coefficient: 0n, scale }
  const settled = smallResult(name, arg, scale)
  if (settled !== undefined) return settled
  const precision = workingScale(name, arg, scale)
  const unit = powerTen(precision)
  const x = rescale(arg, precision).coefficient
  ensureBits((x < 0n ? -x : x).toString(2).length + unit.toString(2).length + 2)
  let coefficient: bigint
  if (name === 's') coefficient = bcSin(x, unit)
  else if (name === 'c') coefficient = bcCos(x, unit)
  else if (name === 'a') coefficient = bcAtan(x, unit)
  else if (name === 'l') coefficient = bcLog(x, unit)
  else coefficient = bcExp(x, unit)
  return rescale({ coefficient, scale: precision }, scale)
}
