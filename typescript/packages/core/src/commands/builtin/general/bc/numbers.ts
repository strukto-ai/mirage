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

export function ensureBits(bits: number): void {
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > constants.MAX_COEFFICIENT_BITS)
    throw new BcRuntimeError(constants.ARITHMETIC_LIMIT)
}

export function powerTen(exponent: number): bigint {
  ensureBits(exponent >= 0 ? 4 * exponent + 1 : -1)
  return 10n ** BigInt(exponent)
}

export function coefficientBits(value: bigint): number {
  if (value === 0n) return 0
  return (value < 0n ? -value : value).toString(2).length
}

export function shiftDecimal(value: bigint, shift: number): bigint {
  if (value === 0n) return 0n
  if (shift >= 0) {
    ensureBits(coefficientBits(value) + 4 * shift)
    return value * powerTen(shift)
  }
  if (-shift >= coefficientBits(value)) return 0n
  return truncDiv(value, powerTen(-shift))
}

export function normalize(num: BcNumber): BcNumber {
  let { coefficient, scale } = num
  if (coefficient === 0n) return ZERO
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n
    scale -= 1
  }
  return { coefficient, scale }
}

export function multiply(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n
  ensureBits(coefficientBits(a) + coefficientBits(b))
  return a * b
}

export function clampScale(scale: number): number {
  return Math.max(0, Math.min(scale, constants.MAX_SCALE))
}

export function truncDiv(a: bigint, b: bigint): bigint {
  return a / b
}

export function rescale(num: BcNumber, scale: number): BcNumber {
  ensureBits(constants.DECIMAL_DIGIT_BITS * scale + 1)
  return { coefficient: shiftDecimal(num.coefficient, scale - num.scale), scale }
}

export function truncateInt(num: BcNumber): bigint {
  return shiftDecimal(num.coefficient, -num.scale)
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
  if (whole.length + fraction.length > constants.MAX_LITERAL_DIGITS)
    throw new BcRuntimeError(constants.ARITHMETIC_LIMIT)
  const scale = fraction.length
  ensureBits(4 * (whole.length + scale) + 1)
  let numerator = 0n
  for (const char of whole) {
    numerator = numerator * BigInt(ibase) + BigInt(digitValue(char, ibase, whole.length > 1))
  }
  for (const char of fraction) {
    numerator = numerator * BigInt(ibase) + BigInt(digitValue(char, ibase, true))
  }
  if (ibase === constants.DEFAULT_BASE) return { coefficient: numerator, scale }
  ensureBits(coefficientBits(BigInt(ibase)) * scale + 1)
  const denominator = BigInt(ibase) ** BigInt(scale)
  return { coefficient: truncDiv(shiftDecimal(numerator, scale), denominator), scale }
}

export function addScale(a: BcNumber, b: BcNumber): number {
  return Math.max(a.scale, b.scale)
}

export function mulScale(a: BcNumber, b: BcNumber, scale: number): number {
  return Math.min(a.scale + b.scale, Math.max(scale, a.scale, b.scale))
}

export function powScale(a: BcNumber, exponent: bigint, scale: number): number {
  if (exponent < 0n) return scale
  const raw = BigInt(a.scale) * exponent
  const ceiling = BigInt(Math.max(scale, a.scale))
  return Number(raw < ceiling ? raw : ceiling)
}

export function divide(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.coefficient === 0n) throw new BcRuntimeError(constants.DIVIDE_BY_ZERO)
  const left = normalize(a)
  const right = normalize(b)
  const shift = right.scale + scale - left.scale
  const numerator = shiftDecimal(left.coefficient, Math.max(shift, 0))
  const denominator = shiftDecimal(right.coefficient, Math.max(-shift, 0))
  return { coefficient: truncDiv(numerator, denominator), scale }
}

export function modulo(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.coefficient === 0n) throw new BcRuntimeError(constants.MODULO_BY_ZERO)
  const quotient = divide(a, b, scale)
  const product = {
    coefficient: multiply(quotient.coefficient, b.coefficient),
    scale: scale + b.scale,
  }
  const resultScale = Math.max(a.scale, product.scale)
  const left = rescale(a, resultScale).coefficient
  const right = rescale(product, resultScale).coefficient
  ensureBits(Math.max(coefficientBits(left), coefficientBits(right)) + 1)
  return { coefficient: left - right, scale: resultScale }
}

export function applyBinary(op: string, a: BcNumber, b: BcNumber, state: BcState): BcNumber {
  const scale = state.scale
  if (op === '+' || op === '-') {
    const resultScale = addScale(a, b)
    const left = rescale(a, resultScale).coefficient
    const right = rescale(b, resultScale).coefficient
    ensureBits(Math.max(coefficientBits(left), coefficientBits(right)) + 1)
    return { coefficient: op === '+' ? left + right : left - right, scale: resultScale }
  }
  if (op === '*')
    return rescale(
      { coefficient: multiply(a.coefficient, b.coefficient), scale: a.scale + b.scale },
      mulScale(a, b, scale),
    )
  if (op === '/') return divide(a, b, scale)
  if (op === '%') return modulo(a, b, scale)
  const exponent = truncateInt(b)
  if (b.scale !== 0) state.warnings.push(runtimeWarningLine(constants.NONZERO_EXPONENT_SCALE))
  if (exponent === 0n) return { coefficient: 1n, scale: 0 }
  const resultScale = powScale(a, exponent, scale)
  const base = normalize(a)
  if (base.coefficient === 0n) {
    if (exponent < 0n) throw new BcRuntimeError(constants.POW_DIVIDE_BY_ZERO)
    return { coefficient: 0n, scale: resultScale }
  }
  const magnitude = exponent < 0n ? -exponent : exponent
  if (base.coefficient === 1n || base.coefficient === -1n) {
    const sign = base.coefficient < 0n && magnitude % 2n !== 0n ? -1n : 1n
    const shift = BigInt(resultScale) - BigInt(base.scale) * exponent
    if (shift < 0n) return { coefficient: 0n, scale: resultScale }
    if (4n * shift + 1n > BigInt(constants.MAX_COEFFICIENT_BITS))
      throw new BcRuntimeError(constants.ARITHMETIC_LIMIT)
    return { coefficient: shiftDecimal(sign, Number(shift)), scale: resultScale }
  }
  if (
    BigInt(coefficientBits(base.coefficient)) * magnitude >
    BigInt(constants.MAX_COEFFICIENT_BITS)
  )
    throw new BcRuntimeError(constants.ARITHMETIC_LIMIT)
  const rawScale = base.scale * Number(magnitude)
  ensureBits(4 * rawScale + 1)
  const power = { coefficient: base.coefficient ** magnitude, scale: rawScale }
  if (exponent < 0n) return divide({ coefficient: 1n, scale: 0 }, power, resultScale)
  return rescale(power, resultScale)
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
  const base = normalize(arg)
  if (base.coefficient === 1n && base.scale === 0) return { coefficient: 1n, scale: 0 }
  const resultScale = Math.max(scale, arg.scale)
  return {
    coefficient: integerSqrt(shiftDecimal(base.coefficient, 2 * resultScale - base.scale)),
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
