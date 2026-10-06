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

import type { FileStat } from '../types.ts'

const MAX_SIZE = Number.MAX_SAFE_INTEGER
const MAX_DIGITS = 16
const DIGITS = /^[0-9]+$/

/**
 * The byte size a backend reply reports, or null when it is not one.
 *
 * Replies spell a size as a JSON number or as a decimal string (Google
 * Drive). Only a non-negative integer that both hosts read exactly counts:
 * a safe integer number, or a string of ASCII digits naming one. `-0`
 * comes back as `0`. Anything else is null, so a caller falls back to the
 * bytes it sent.
 *
 * @param value the reply's size field
 */
export function reportedSize(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    if (value.length > MAX_DIGITS || !DIGITS.test(value)) return null
    n = Number(value)
  } else {
    return null
  }
  if (!Number.isInteger(n) || n < 0 || n > MAX_SIZE) return null
  return n === 0 ? 0 : n
}

/**
 * The stored size and token an upload reply names for a write.
 *
 * `item` is the stored file's metadata as the backend answered it, typed as
 * the item `statOf` (the backend's own stat parser, so the write's token is
 * the kind its `stat` reports) reads. The size is {@link reportedSize} of its
 * `size` field, else `sent`; the token is read only when the reply reports a
 * size. The upload has landed by now, so nothing here throws: a reply that is
 * not a JSON object answers `[sent, null]`, and a parser that fails keeps the
 * reported size and drops just the token, so a stored size other than `sent`
 * still reaches the cache's size check. Mirrors python's `upload_receipt`.
 */
export function uploadReceipt<T extends object>(
  item: T | null | undefined,
  statOf: (item: T) => FileStat,
  sent: number,
  virtual: string,
): [size: number, token: string | null] {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return [sent, null]
  const size = reportedSize((item as { size?: unknown }).size)
  if (size === null) return [sent, null]
  try {
    const token = statOf(item).fingerprint
    return [size, token === null || token === '' ? null : token]
  } catch (err) {
    console.warn(`unreadable upload reply for ${virtual}: ${String(err)}`)
    return [size, null]
  }
}
