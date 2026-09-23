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

import { formatE, formatF, formatG } from '../../workspace/executor/builtins/printf/format.ts'

const NUMERIC_STRING = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/

const NUMERIC_PREFIX = /^[ \t\n]*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?/

const CONVFMT_SPEC = /^%([-+ #0]*)([0-9]*)(\.[0-9]*)?([eEfFgG])$/

const DEFAULT_CONVFMT = '%.6g'

const BLANK_EDGES = /^[ \t\n]+|[ \t\n]+$/g

const INT_LIMIT = 2 ** 63

const INT_CLAMP = 2n ** 63n

export const ValueKind = {
  UNINIT: 'UNINIT',
  NUM: 'NUM',
  STR: 'STR',
  STRNUM: 'STRNUM',
} as const
export type ValueKind = (typeof ValueKind)[keyof typeof ValueKind]

export interface Value {
  readonly kind: ValueKind
  readonly num: number
  readonly text: string
}

export const UNINIT: Value = { kind: ValueKind.UNINIT, num: 0, text: '' }

export function num(value: number): Value {
  return { kind: ValueKind.NUM, num: value, text: '' }
}

export function text(value: string): Value {
  return { kind: ValueKind.STR, num: 0, text: value }
}

export function stripBlanks(raw: string): string {
  return raw.replace(BLANK_EDGES, '')
}

/** Whether a string lexically matches an awk NUMBER token, blanks aside. */
export function looksNumeric(raw: string): boolean {
  const stripped = stripBlanks(raw)
  if (stripped === '') return false
  return NUMERIC_STRING.test(stripped)
}

/**
 * Wrap input-derived text, tagging it strnum when it looks numeric.
 * Fields, split() output and command-line assignments produce these; the
 * tag is what makes `$1 == 10` a numeric comparison. An absent or empty
 * field is a plain string: every awk agrees `$9 == 0` is false while
 * `x == 0` is true for an unset variable x.
 */
export function strnum(raw: string): Value {
  if (raw === '') return text('')
  if (looksNumeric(raw)) return { kind: ValueKind.STRNUM, num: parseNumber(raw), text: raw }
  return text(raw)
}

/** Convert a leading numeric prefix to a number, strtod style. */
export function parseNumber(raw: string): number {
  const match = NUMERIC_PREFIX.exec(raw)
  if (match === null) return 0
  const body = stripBlanks(match[0])
  if (body === '' || body === '+' || body === '-') return 0
  return Number(body)
}

export function toNum(value: Value): number {
  if (value.kind === ValueKind.UNINIT) return 0
  if (value.kind === ValueKind.NUM || value.kind === ValueKind.STRNUM) return value.num
  return parseNumber(value.text)
}

/**
 * Truncate toward zero the way awk reads an integer. NaN reads as 0 and
 * an infinity clamps to the 64-bit edge, so a field index or a substr
 * position never misbehaves on a degenerate number.
 */
export function toInt(value: number): bigint {
  if (Number.isNaN(value)) return 0n
  if (!Number.isFinite(value)) return value > 0 ? INT_CLAMP : -INT_CLAMP
  return BigInt(Math.trunc(value))
}

/** `toInt` narrowed to a safe JS number, for positions and counts. */
export function toIndex(value: number): number {
  const wide = toInt(value)
  if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  if (wide < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER
  return Number(wide)
}

function applyConvfmt(value: number, convfmt: string): string {
  const match = CONVFMT_SPEC.exec(convfmt) ?? CONVFMT_SPEC.exec(DEFAULT_CONVFMT)
  if (match === null) return String(value)
  const flags = match[1] ?? ''
  const width = match[2] !== undefined && match[2] !== '' ? Number(match[2]) : null
  const precision = match[3] === undefined ? null : Number(match[3].slice(1) || '0')
  return formatFloat(match[4] ?? 'g', value, flags, width, precision)
}

export function formatFloat(
  conv: string,
  value: number,
  flags: string,
  width: number | null,
  precision: number | null,
): string {
  const upper = conv === conv.toUpperCase()
  const lower = conv.toLowerCase()
  if (lower === 'f') return formatF(value, flags, width, precision, upper)
  if (lower === 'e') return formatE(value, flags, width, precision, upper)
  return formatG(value, flags, width, precision, upper)
}

/**
 * Render a number the way awk converts numbers to strings: an integral
 * value prints as an integer whatever CONVFMT says, anything else goes
 * through CONVFMT (or OFMT for output).
 */
export function formatNum(value: number, convfmt: string): string {
  if (Number.isNaN(value)) return 'nan'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  if (Number.isInteger(value) && Math.abs(value) < INT_LIMIT) return BigInt(value).toString()
  return applyConvfmt(value, convfmt)
}

export function toStr(value: Value, convfmt: string): string {
  if (value.kind === ValueKind.UNINIT) return ''
  if (value.kind === ValueKind.NUM) return formatNum(value.num, convfmt)
  return value.text
}

export function isTrue(value: Value): boolean {
  if (value.kind === ValueKind.UNINIT) return false
  if (value.kind === ValueKind.NUM || value.kind === ValueKind.STRNUM) return value.num !== 0
  return value.text !== ''
}

function comparesNumerically(value: Value): boolean {
  return value.kind !== ValueKind.STR
}

/**
 * Compare two awk values. POSIX compares numerically when both sides are
 * numeric, numeric strings or uninitialized, and lexically otherwise.
 */
export function compare(left: Value, right: Value, convfmt: string): number {
  if (comparesNumerically(left) && comparesNumerically(right)) {
    const lhs = toNum(left)
    const rhs = toNum(right)
    if (lhs === rhs) return 0
    return lhs < rhs ? -1 : 1
  }
  const lhs = toStr(left, convfmt)
  const rhs = toStr(right, convfmt)
  if (lhs === rhs) return 0
  return lhs < rhs ? -1 : 1
}
