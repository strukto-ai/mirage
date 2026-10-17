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

import type { BcNumber } from './types.ts'
import { integerSqrt, integerText, rescale, truncDiv } from './numbers.ts'

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
  for (let n = 0; n < squarings; n++) sum = truncDiv(sum * sum, unit)
  return negative ? truncDiv(unit * unit, sum) : sum
}

export function logDomainValue(scale: number): BcNumber {
  return { coefficient: (1n - 10n ** BigInt(scale)) * 10n ** BigInt(scale), scale }
}

// GNU bc 1.07.1 can lose digits through intermediate math truncation.
// Guard digits retain precision, matching GNU evaluated at higher scale.
export function workingScale(name: string, arg: BcNumber, scale: number): number {
  const magnitude = arg.coefficient < 0n ? -arg.coefficient : arg.coefficient
  const integerDigits = Math.max(0, integerText(magnitude).length - arg.scale)
  const base = Math.max(scale, arg.scale) + 16
  if (name === 's' || name === 'c') return base + integerDigits
  if (name === 'e') {
    const integer = rescale(arg, 0).coefficient
    return base + Number(integer > 0n ? integer / 2n : 0n)
  }
  return base
}

export function callFunction(name: string, arg: BcNumber, scale: number): BcNumber {
  if (name === 'l' && arg.coefficient <= 0n) return logDomainValue(scale)
  if (
    name === 'e' &&
    arg.coefficient < 0n &&
    -arg.coefficient > BigInt(3 * (scale + 16)) * 10n ** BigInt(arg.scale)
  ) {
    return { coefficient: 0n, scale }
  }
  const precision = workingScale(name, arg, scale)
  const unit = 10n ** BigInt(precision)
  const x = rescale(arg, precision).coefficient
  let coefficient: bigint
  if (name === 's') coefficient = bcSin(x, unit)
  else if (name === 'c') coefficient = bcCos(x, unit)
  else if (name === 'a') coefficient = bcAtan(x, unit)
  else if (name === 'l') coefficient = bcLog(x, unit)
  else coefficient = bcExp(x, unit)
  return rescale({ coefficient, scale: precision }, scale)
}
