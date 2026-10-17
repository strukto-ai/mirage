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

import * as constants from './constants.ts'
import { BcParseError, BcRuntimeError, runtimeWarningLine } from './errors.ts'
import type { BcNumber, BcState } from './types.ts'

export const ZERO: BcNumber = { coefficient: 0n, scale: 0 }

export function clampScale(scale: number): number {
  return Math.max(0, Math.min(scale, constants.MAX_SCALE))
}

export function truncDiv(a: bigint, b: bigint): bigint {
  return a / b
}

export function rescale(num: BcNumber, scale: number): BcNumber {
  const shift = scale - num.scale
  const coefficient =
    shift >= 0
      ? num.coefficient * 10n ** BigInt(shift)
      : truncDiv(num.coefficient, 10n ** BigInt(-shift))
  return { coefficient, scale }
}

export function truncateInt(num: BcNumber): bigint {
  return rescale(num, 0).coefficient
}

export function digitValue(char: string, ibase: number, clamp: boolean): number {
  const value = constants.BASE_DIGITS.indexOf(char)
  return clamp && value >= ibase ? ibase - 1 : value
}

export function readBaseNumber(raw: string, ibase: number): BcNumber {
  const dot = raw.indexOf('.')
  const whole = dot < 0 ? raw : raw.slice(0, dot)
  const fraction = dot < 0 ? '' : raw.slice(dot + 1)
  if (fraction.includes('.')) throw new BcParseError(constants.SYNTAX_ERROR)
  const scale = fraction.length
  let numerator = 0n
  for (const char of whole) {
    numerator = numerator * BigInt(ibase) + BigInt(digitValue(char, ibase, whole.length > 1))
  }
  for (const char of fraction) {
    numerator = numerator * BigInt(ibase) + BigInt(digitValue(char, ibase, true))
  }
  return {
    coefficient: truncDiv(
      numerator * 10n ** BigInt(scale),
      BigInt(ibase) ** BigInt(fraction.length),
    ),
    scale,
  }
}

export function addScale(a: BcNumber, b: BcNumber): number {
  return Math.max(a.scale, b.scale)
}

export function mulScale(a: BcNumber, b: BcNumber, scale: number): number {
  return Math.min(a.scale + b.scale, Math.max(scale, a.scale, b.scale))
}

export function powScale(a: BcNumber, exponent: bigint, scale: number): number {
  if (exponent < 0n) return clampScale(scale)
  const raw = BigInt(a.scale) * exponent
  const ceiling = BigInt(Math.max(scale, a.scale))
  return Number(raw < ceiling ? raw : ceiling)
}

export function divide(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.coefficient === 0n) throw new BcRuntimeError(constants.DIVIDE_BY_ZERO)
  const shift = b.scale + scale - a.scale
  const numerator = a.coefficient * 10n ** BigInt(Math.max(shift, 0))
  const denominator = b.coefficient * 10n ** BigInt(Math.max(-shift, 0))
  return { coefficient: truncDiv(numerator, denominator), scale }
}

export function modulo(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.coefficient === 0n) throw new BcRuntimeError(constants.MODULO_BY_ZERO)
  const quotient = divide(a, b, scale)
  const product = { coefficient: quotient.coefficient * b.coefficient, scale: scale + b.scale }
  const resultScale = Math.max(a.scale, product.scale)
  return rescale(
    {
      coefficient: rescale(a, resultScale).coefficient - rescale(product, resultScale).coefficient,
      scale: resultScale,
    },
    resultScale,
  )
}

export function applyBinary(op: string, a: BcNumber, b: BcNumber, state: BcState): BcNumber {
  const scale = state.scale
  if (op === '+' || op === '-') {
    const resultScale = addScale(a, b)
    const left = rescale(a, resultScale).coefficient
    const right = rescale(b, resultScale).coefficient
    return { coefficient: op === '+' ? left + right : left - right, scale: resultScale }
  }
  if (op === '*')
    return rescale(
      { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale },
      mulScale(a, b, scale),
    )
  if (op === '/') return divide(a, b, scale)
  if (op === '%') return modulo(a, b, scale)
  const exponent = truncateInt(b)
  if (b.scale !== 0) state.warnings.push(runtimeWarningLine(constants.NONZERO_EXPONENT_SCALE))
  if (exponent === 0n) return { coefficient: 1n, scale: 0 }
  if (a.coefficient === 0n && exponent < 0n) throw new BcRuntimeError(constants.POW_DIVIDE_BY_ZERO)
  const magnitude = exponent < 0n ? -exponent : exponent
  const coefficient = a.coefficient ** magnitude
  const rawScale = BigInt(a.scale) * magnitude
  const resultScale = powScale(a, exponent, scale)
  if (exponent < 0n) {
    return {
      coefficient: truncDiv(10n ** (rawScale + BigInt(resultScale)), coefficient),
      scale: resultScale,
    }
  }
  return {
    coefficient: truncDiv(coefficient, 10n ** (rawScale - BigInt(resultScale))),
    scale: resultScale,
  }
}

export function integerSqrt(value: bigint): bigint {
  if (value < 2n) return value
  let root = 1n << BigInt(Math.ceil(value.toString(2).length / 2))
  for (;;) {
    const next = (root + value / root) / 2n
    if (next >= root) return root
    root = next
  }
}

export function bcSqrt(arg: BcNumber, scale: number): BcNumber {
  if (arg.coefficient < 0n) throw new BcRuntimeError(constants.NEGATIVE_SQRT)
  if (arg.coefficient === 0n) return ZERO
  if (arg.coefficient === 10n ** BigInt(arg.scale)) return { coefficient: 1n, scale: 0 }
  const resultScale = Math.max(scale, arg.scale)
  return {
    coefficient: integerSqrt(arg.coefficient * 10n ** BigInt(2 * resultScale - arg.scale)),
    scale: resultScale,
  }
}

export function integerText(value: bigint): string {
  return value.toString()
}

export function bcLength(num: BcNumber): number {
  const magnitude = num.coefficient < 0n ? -num.coefficient : num.coefficient
  return Math.max(integerText(magnitude).length, num.scale)
}

export function callBuiltin(name: string, arg: BcNumber, scale: number): BcNumber {
  if (name === constants.LENGTH_NAME) return { coefficient: BigInt(bcLength(arg)), scale: 0 }
  if (name === constants.SCALE_NAME) return { coefficient: BigInt(arg.scale), scale: 0 }
  return bcSqrt(arg, scale)
}
