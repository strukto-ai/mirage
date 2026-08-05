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

/**
 * An HTTP `Range` value for a byte window, or null for the whole file.
 *
 * Every HTTP-backed store spells a partial read the same way, so the spelling
 * lives here rather than once per backend. `null` means the caller wants
 * everything and should send no header at all.
 *
 * A zero-length window has no HTTP spelling: `bytes=N--1` is malformed and an
 * absent header means the opposite of what was asked. It is refused here so a
 * caller that forgot to short-circuit finds out rather than silently
 * downloading the whole object.
 *
 * @param offset first byte to read
 * @param size how many bytes, or null for the rest of the file
 */
export function rangeHeader(offset: number, size: number | null): string | null {
  if (offset < 0) throw new RangeError(`range offset must be non-negative: ${String(offset)}`)
  if (size !== null && size < 0)
    throw new RangeError(`range size must be non-negative: ${String(size)}`)
  if (size === 0) throw new RangeError('a zero-length range has no HTTP spelling')
  if (offset === 0 && size === null) return null
  const end = size === null ? '' : String(offset + size - 1)
  return `bytes=${String(offset)}-${end}`
}

/**
 * The requested window out of bytes already in hand.
 *
 * The answer when nothing remote can serve a range: a store that renders its
 * content, or one whose reader has no range support.
 *
 * @param data the whole content
 * @param offset first byte to keep
 * @param size how many bytes, or null for the rest
 */
export function sliceWindow(data: Uint8Array, offset: number, size: number | null): Uint8Array {
  return data.slice(offset, size === null ? undefined : offset + size)
}
