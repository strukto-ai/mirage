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

// Mirrors python's re \w (unicode letters/digits/underscore), unlike JS \w.
const UNSAFE_CHARS = /[^\p{L}\p{N}_\s\-.]/gu
const MULTI_UNDERSCORE = /_+/g
const MAX_LEN = 100
// POSIX NAME_MAX on ext4 and APFS alike, and it counts BYTES. Truncating by
// characters is the same number only for ASCII: a 100-character CJK title is
// 300 bytes.
export const NAME_MAX_BYTES = 255

const UTF8 = new TextEncoder()
const UTF8_LOSSY = new TextDecoder('utf-8')

/**
 * Trim a string to fit a byte budget without splitting a character.
 *
 * Returns `text` unchanged when it already fits, else the longest prefix
 * whose UTF-8 encoding is at most `budget` bytes.
 */
export function truncateBytes(text: string, budget: number): string {
  if (budget <= 0) return ''
  const raw = UTF8.encode(text)
  if (raw.length <= budget) return text
  // The decoder replaces the partial sequence the cut may have left with
  // U+FFFD, which is exactly the trailing character that did not fit.
  return UTF8_LOSSY.decode(raw.slice(0, budget)).replace(/�+$/u, '')
}

export function stripUnderscores(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '_') start += 1
  while (end > start && value[end - 1] === '_') end -= 1
  return value.slice(start, end)
}

/**
 * Sanitize a name for use in virtual paths.
 *
 * Replaces shell-unsafe characters (apostrophes, quotes, etc.) and spaces
 * with underscores. Safe for use in shell commands without quoting.
 */
export function sanitizeName(name: string): string {
  if (name.trim() === '') return 'unknown'
  let cleaned = name.replace(UNSAFE_CHARS, '_')
  cleaned = cleaned.replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_')
  cleaned = stripUnderscores(cleaned)
  if (cleaned.length > MAX_LEN) cleaned = cleaned.slice(0, MAX_LEN)
  return cleaned
}

/**
 * Make a name safe to embed in a VFS path segment.
 *
 * Preserves the original spelling (spaces, apostrophes, emoji, etc.) and only
 * replaces the path separator `/` with `∕` (U+2215) so the value cannot
 * collide with a directory boundary. Use this for resource directory and file
 * names where keeping the original display name matters more than shell
 * ergonomics.
 */
export function pathSafeName(name: string): string {
  if (name.trim() === '') return 'unknown'
  return name.replace(/\//g, '∕')
}
