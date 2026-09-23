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
const MULTI_UNDERSCORE = /_+/g
const MAX_LEN = 100
// POSIX NAME_MAX on ext4 and APFS alike, and it counts BYTES. Truncating by
// characters is the same number only for ASCII: a 100-character CJK title is
// 300 bytes.
export const NAME_MAX_BYTES = 255
const ELLIPSIS = '...'
// What `/` becomes inside a path segment: U+2215 DIVISION SLASH, the one
// character every backend renders a slash as, so a value cannot open a
// directory boundary. `core/hierarchy/codec` is what inverts it.
export const SAFE_SLASH = '∕'
// What marks the next character of a path segment as literal: U+2044
// FRACTION SLASH. `pathSafeName` leads a dot-led name with it, since the
// hierarchy hides a dot-led segment, and `core/hierarchy/codec` spells its
// reversible encoding with it.
export const ESCAPE_LEAD = '⁄'
// Unicode's White_Space property (PropList.txt), spelled out rather than read
// off `trim`: JavaScript's `trim` also strips U+FEFF and leaves U+0085, and
// python's `str.strip` also strips U+001C..U+001F, so a value blank in one
// runtime rendered a segment the other runtime spelled out.
const WHITE_SPACE_CLASS =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const WHITE_SPACE = new RegExp(`^[${WHITE_SPACE_CLASS}]*$`, 'u')
// The same class, not `\s`: JavaScript's `\s` takes U+FEFF and python's
// takes U+001C..U+001F, so one runtime kept a character the other replaced.
const UNSAFE_CHARS = new RegExp(`[^\\p{L}\\p{N}_${WHITE_SPACE_CLASS}\\-.]`, 'gu')

const UTF8 = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8')

/** Whether the text is empty or nothing but white space: Unicode White_Space. */
export function isBlank(text: string): boolean {
  return WHITE_SPACE.test(text)
}

/** Measure a string the way the filesystem does: in UTF-8 bytes. */
export function byteLength(text: string): number {
  return UTF8.encode(text).length
}

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
  // Cut on a character boundary by walking back over continuation bytes
  // (0b10xxxxxx), so the slice never ends mid-sequence and the decoder has
  // nothing to replace. Decoding first and stripping U+FFFD afterwards
  // needs an anchored `+` quantifier, which backtracks polynomially on an
  // input the calendar controls.
  let end = budget
  while (end > 0 && ((raw[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return UTF8_DECODER.decode(raw.slice(0, end))
}

/** Trim trailing underscores, linearly. python's `str.rstrip("_")`. */
export function stripTrailingUnderscores(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '_') end -= 1
  return value.slice(0, end)
}

/** python's `str.rstrip("_.")`, so a byte cut cannot leave `Foo.....`. */
function stripTrailingUnderscoresAndDots(value: string): string {
  let end = value.length
  while (end > 0 && (value[end - 1] === '_' || value[end - 1] === '.')) end -= 1
  return value.slice(0, end)
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
  if (isBlank(name)) return 'unknown'
  let cleaned = name.replace(UNSAFE_CHARS, '_')
  cleaned = cleaned.replace(/ /g, '_')
  cleaned = cleaned.replace(MULTI_UNDERSCORE, '_')
  cleaned = stripUnderscores(cleaned)
  // Code points, not UTF-16 units -- see sanitizeLabel.
  const points = Array.from(cleaned)
  if (points.length > MAX_LEN) cleaned = points.slice(0, MAX_LEN).join('')
  return cleaned
}

/**
 * Make a name safe to embed in a VFS path segment.
 *
 * Preserves the original spelling (spaces, apostrophes, emoji, etc.) and only
 * replaces the path separator `/` with `SAFE_SLASH` (`∕`, U+2215), so the value
 * cannot collide with a directory boundary, and leads a name that starts with
 * `.` with `ESCAPE_LEAD` (`⁄`, U+2044), since the hierarchy classifies a
 * dot-led segment as hidden: it would be dropped from every listing and refused
 * as a path. Use this for VFS directory and file names where keeping the
 * original display name matters more than shell ergonomics.
 */
export function pathSafeName(name: string): string {
  if (isBlank(name)) return 'unknown'
  const safe = name.replace(/\//g, SAFE_SLASH)
  return safe.startsWith('.') ? ESCAPE_LEAD + safe : safe
}

/**
 * Sanitize an API-supplied label for use inside a filename.
 *
 * The shared body behind every backend's title/subject sanitizer: replace
 * shell-unsafe characters and spaces with underscores, collapse the runs, trim
 * the edges, then ellipsize past the budget. Backends differ only in what an
 * empty label becomes and how long a label may be, so those are the arguments.
 *
 * Unlike `sanitizeName` this ellipsizes rather than hard-cutting, so a
 * truncated name reads as truncated.
 *
 * Two budgets apply, and both have to: `maxLen` is the readable length a
 * backend wants, while `maxBytes` is what the filesystem will actually
 * accept. They are the same number only for ASCII, so a 100-character CJK
 * title passed a 100-character budget untouched and rendered a 300-byte
 * filename, which ext4 and APFS reject with ENAMETOOLONG. Pass the bytes the
 * *rest* of the filename does not already use -- see `makeFilename` in the
 * gdocs/gsheets/gslides entries and `makeEventFilename` in gcal, which is
 * where the fixed overhead is known.
 */
export function sanitizeLabel(
  text: string,
  options: { fallback: string; maxLen: number; maxBytes?: number },
): string {
  if (isBlank(text)) return options.fallback
  let cleaned = text.replace(UNSAFE_CHARS, '_').replace(/ /g, '_').replace(MULTI_UNDERSCORE, '_')
  cleaned = stripUnderscores(cleaned)
  // The budget counts characters, and python counts code points where
  // `String.length` counts UTF-16 units. Measuring in units both truncates a
  // label python leaves whole and can cut a surrogate pair in half, which
  // encodes as U+FFFD in the filename.
  const points = Array.from(cleaned)
  if (points.length > options.maxLen) {
    cleaned = `${points.slice(0, options.maxLen - ELLIPSIS.length).join('')}${ELLIPSIS}`
  }
  const maxBytes = options.maxBytes ?? NAME_MAX_BYTES
  if (byteLength(cleaned) > maxBytes) {
    const head = stripTrailingUnderscoresAndDots(
      truncateBytes(cleaned, Math.max(maxBytes - ELLIPSIS.length, 0)),
    )
    cleaned = head !== '' ? `${head}${ELLIPSIS}` : truncateBytes(cleaned, maxBytes)
  }
  return cleaned
}
