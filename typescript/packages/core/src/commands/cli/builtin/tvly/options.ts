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

// Option values are checked as tvly 1.0.2's src/commands/options.ts and
// src/core/search-flags.ts check them, and refused in commander 15's words,
// which tvly answers every usage error in (MIT; see
// licenses/third_party/tavily-cli.txt).

import type { JsonValue } from '../../../../types.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import { jsTrim } from './render.ts'

const DECIMAL = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity)$/
const RADIX = /^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$/

/** An option value tvly refuses, worded as commander words it. */
export class InvalidOption extends Error {
  constructor(flags: string, raw: string, reason: string) {
    super(`error: option '${flags}' argument '${raw}' is invalid. ${reason}`)
    this.name = 'InvalidOption'
  }
}

/** `Number(raw)`: NaN for text JavaScript does not read as one. */
export function jsNumber(raw: string): number {
  const text = jsTrim(raw)
  if (text === '') return 0
  return DECIMAL.test(text) || RADIX.test(text) ? Number(text) : Number.NaN
}

function spell(n: number): string {
  return String(n)
}

/** A numeric option value, refused as tvly refuses it. */
export function parseNumber(
  raw: string,
  flags: string,
  options: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number {
  const n = jsTrim(raw) === '' ? Number.NaN : jsNumber(raw)
  if (Number.isNaN(n)) throw new InvalidOption(flags, raw, 'Not a number.')
  if (options.integer === true && !Number.isInteger(n)) {
    throw new InvalidOption(flags, raw, 'Not an integer.')
  }
  if (options.minimum !== undefined && n < options.minimum) {
    throw new InvalidOption(
      flags,
      raw,
      `${spell(n)} is below the minimum ${spell(options.minimum)}.`,
    )
  }
  if (options.maximum !== undefined && n > options.maximum) {
    throw new InvalidOption(
      flags,
      raw,
      `${spell(n)} is above the maximum ${spell(options.maximum)}.`,
    )
  }
  return n
}

/** A value one of `choices` must be, refused as commander does. */
export function checkChoice(raw: string, flags: string, choices: readonly string[]): string {
  if (!choices.includes(raw)) {
    throw new InvalidOption(flags, raw, `Allowed choices are ${choices.join(', ')}.`)
  }
  return raw
}

/** A comma-separated value as its parts, each trimmed; empty or absent is undefined. */
export function splitCsv(value: string | undefined): string[] | undefined {
  return value ? value.split(',').map((part) => jsTrim(part)) : undefined
}

/** A numeric option, checked at each place the line typed it. */
export function typedNumber(
  fl: FlagView,
  name: string,
  flags: string,
  options: { integer?: boolean; fallback?: number } = {},
): number | undefined {
  let value = options.fallback
  for (const [, raw] of fl.texts(name)) {
    value = parseNumber(raw, flags, options.integer === true ? { integer: true } : {})
  }
  return value
}

/** A choice option, checked at each place the line typed it. */
export function typedChoice(
  fl: FlagView,
  name: string,
  flags: string,
  choices: readonly string[],
): string | undefined {
  let value: string | undefined
  for (const [, raw] of fl.texts(name)) value = checkChoice(raw, flags, choices)
  return value
}

/** The `--client-name` the line gave, or `TAVILY_CLIENT_NAME`; an empty one is none. */
export function clientNameOf(fl: FlagView): string | undefined {
  const name = fl.asStr('client_name')
  return name === '' ? undefined : name
}

/** Set `key` when the line gave a value for it. */
export function defined(
  body: Record<string, JsonValue>,
  key: string,
  value: JsonValue | undefined,
): void {
  if (value !== undefined && value !== null) body[key] = value
}
