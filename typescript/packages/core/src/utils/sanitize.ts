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

import { fromUnits, units } from '../rs/document.ts'
import { openStreamSync } from '../rs/stream.ts'
import type { JsonValue } from '../types.ts'

// POSIX NAME_MAX on ext4 and APFS alike, and it counts BYTES. Truncating by
// characters is the same number only for ASCII: a 100-character CJK title is
// 300 bytes.
export const NAME_MAX_BYTES = 255
// What `/` becomes inside a path segment: U+2215 DIVISION SLASH, the one
// character every backend renders a slash as, so a value cannot open a
// directory boundary. `core/hierarchy/codec` is what inverts it.
export const SAFE_SLASH = '∕'
// What marks the next character of a path segment as literal: U+2044
// FRACTION SLASH. `pathSafeName` leads a dot-led name with it, since the
// hierarchy hides a dot-led segment, and `core/hierarchy/codec` spells its
// reversible encoding with it.
export const ESCAPE_LEAD = '⁄'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** Answer one of mirage-rs's filename rules, its text as code points. */
function sanitize(config: Record<string, JsonValue>): JsonValue {
  const stream = openStreamSync('sanitize', config)
  try {
    return JSON.parse(DECODER.decode(stream.finish())) as JsonValue
  } finally {
    stream.close()
  }
}

/** Whether the text is empty or nothing but Unicode White_Space. */
export function isBlank(text: string): boolean {
  return sanitize({ op: 'blank', text: units(text) }) === true
}

/** Measure a string the way the filesystem does: in UTF-8 bytes. */
export function byteLength(text: string): number {
  return ENCODER.encode(text).length
}

/** Trim a string to fit a byte budget without splitting a character. */
export function truncateBytes(text: string, budget: number): string {
  return fromUnits(sanitize({ op: 'truncate', text: units(text), budget }) as number[])
}

/** Trim trailing underscores, linearly. python's `str.rstrip("_")`. */
export function stripTrailingUnderscores(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '_') end -= 1
  return value.slice(0, end)
}

/**
 * Sanitize a name for use in virtual paths: shell-unsafe characters and
 * spaces become underscores, so the name needs no quoting. Never dot-led,
 * never empty (`unknown`), at most 100 characters.
 */
export function sanitizeName(name: string): string {
  return fromUnits(sanitize({ op: 'name', text: units(name) }) as number[])
}

/**
 * Make a name safe to embed in a VFS path segment: the original spelling,
 * `/` replaced with `SAFE_SLASH` and a dot-led name led with `ESCAPE_LEAD`,
 * since the hierarchy hides a dot-led segment. A blank name is `unknown`.
 */
export function pathSafeName(name: string): string {
  return fromUnits(sanitize({ op: 'path', text: units(name) }) as number[])
}

/**
 * Sanitize an API-supplied label for use inside a filename: as
 * `sanitizeName`, but ellipsized past either budget, so a truncated name
 * reads as truncated. `maxLen` is the readable length a backend wants and
 * `maxBytes` what the filesystem accepts; pass the bytes the rest of the
 * filename does not already use.
 */
export function sanitizeLabel(
  text: string,
  options: { fallback: string; maxLen: number; maxBytes?: number },
): string {
  return fromUnits(
    sanitize({
      op: 'label',
      text: units(text),
      fallback: options.fallback,
      max_len: options.maxLen,
      max_bytes: options.maxBytes ?? NAME_MAX_BYTES,
    }) as number[],
  )
}
