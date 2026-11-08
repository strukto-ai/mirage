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

/** One byte array holding every chunk in order. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Whether `data` begins with `prefix`, as Python's `bytes.startswith`. */
export function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > data.length) return false
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false
  return true
}

/** Where `needle` first occurs in `haystack` at or after `from`, -1 when it
 * does not; an empty `needle` occurs at `from`. */
export function findBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
