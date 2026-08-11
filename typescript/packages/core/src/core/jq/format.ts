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

import { RS, type JqOptions } from './types.ts'

const ENC = new TextEncoder()
const NON_ASCII = /[\u0080-\uFFFF]/g
const NUL = new Uint8Array([0])
const NEWLINE = ENC.encode('\n')
const EMPTY = new Uint8Array(0)
const RS_BYTES = ENC.encode(RS)

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, unknown> = {}
  for (const [key, inner] of entries) out[key] = sortDeep(inner)
  return out
}

function escapeNonAscii(text: string): string {
  // One \uXXXX per UTF-16 code unit, so an astral character escapes as
  // its surrogate pair, which is what jq and Python's json both print.
  return text.replace(NON_ASCII, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

function dumps(value: unknown, opts: JqOptions): string {
  const sorted = opts.sortKeys ? sortDeep(value) : value
  const indent = opts.compact || opts.indent === 0 ? undefined : opts.tab ? '\t' : opts.indent
  const json = JSON.stringify(sorted, null, indent)
  return opts.asciiOutput ? escapeNonAscii(json) : json
}

function terminator(opts: JqOptions): Uint8Array {
  // --raw-output0 wins over -j whichever order they were typed, which is
  // what jq does.
  if (opts.nulOutput) return NUL
  return opts.joinOutput ? EMPTY : NEWLINE
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** Render one output value with its separator. */
export function formatOne(value: unknown, opts: JqOptions): Uint8Array {
  // -a beats -r: jq quotes and escapes a string under --ascii-output
  // even when raw output was asked for.
  const body =
    opts.rawOutput && !opts.asciiOutput && typeof value === 'string'
      ? ENC.encode(value)
      : ENC.encode(dumps(value, opts))
  // RFC 7464 puts the separator before the value, not after it.
  const prefix = opts.seq ? RS_BYTES : EMPTY
  return concatBytes([prefix, body, terminator(opts)])
}

/** Render every output of a jq program, one per line. */
export function formatJqOutput(outputs: readonly unknown[], opts: JqOptions): Uint8Array {
  const parts: Uint8Array[] = []
  for (const value of outputs) parts.push(formatOne(value, opts))
  return concatBytes(parts)
}
