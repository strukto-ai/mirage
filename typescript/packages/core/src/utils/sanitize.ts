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

import { openStreamSync } from '../rs/stream.ts'
import type { JsonValue } from '../types.ts'

export const NAME_MAX_BYTES = 255
export const SAFE_SLASH = '∕'
export const ESCAPE_LEAD = '⁄'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder('utf-8', { ignoreBOM: true })

function sanitize(text: string, config: Record<string, JsonValue>): string {
  const stream = openStreamSync('sanitize', config)
  try {
    stream.feed(ENCODER.encode(text))
    return DECODER.decode(stream.finish())
  } finally {
    stream.close()
  }
}

/** Test Unicode White_Space. */
export function isBlank(text: string): boolean {
  return sanitize(text, { op: 'blank' }) === '1'
}

/** Measure a filename in UTF-8 bytes. */
export function byteLength(text: string): number {
  return ENCODER.encode(text).length
}

/** Keep a UTF-8 prefix without splitting a character. */
export function truncateBytes(text: string, budget: number): string {
  return sanitize(text, { op: 'truncate', budget })
}

/** Trim trailing underscores, linearly. python's `str.rstrip("_")`. */
export function stripTrailingUnderscores(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '_') end -= 1
  return value.slice(0, end)
}

/** Render a shell-safe, nonempty name. */
export function sanitizeName(name: string): string {
  return sanitize(name, { op: 'name' })
}

/** Escape separators and a leading dot, preserving spelling. */
export function pathSafeName(name: string): string {
  return sanitize(name, { op: 'path' })
}

/** Render a shell-safe label under character and UTF-8 byte budgets. */
export function sanitizeLabel(
  text: string,
  options: { fallback: string; maxLen: number; maxBytes?: number },
): string {
  return sanitize(text, {
    op: 'label',
    fallback: options.fallback,
    max_len: options.maxLen,
    max_bytes: options.maxBytes ?? NAME_MAX_BYTES,
  })
}
