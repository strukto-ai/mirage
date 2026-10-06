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

const ENC = new TextEncoder()
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const SURROGATE_BASE = 0xdc00
const SURROGATE_LOW = 0xdc80
const SURROGATE_HIGH = 0xdcff
const HIGH_SURROGATE_LOW = 0xd800
const HIGH_SURROGATE_HIGH = 0xdbff
const ASCII_MAX = 0x80
const BYTE_MASK = 0xff
const VIEW_CHUNK = 8192
const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const
const UTF8_CODESET = 'utf8'

/**
 * Stand in for one raw output byte inside a text string.
 *
 * `\xHH` and `\NNN` name a byte, not a code point: bash writes `\xff` as
 * the single byte 0xFF, which is not valid UTF-8 on its own and so has no
 * character to stand for it. A byte above ASCII is therefore carried as
 * its surrogate escape, the same convention Python's own filesystem paths
 * use, and `encodeText` turns it back into that byte.
 *
 * Three octal digits reach past one byte (`\400` is 256, `\777` is 511)
 * and bash writes the low byte of those, so the value is masked rather
 * than refused.
 */
export function byteChar(value: number): string {
  const byte = value & BYTE_MASK
  return String.fromCharCode(byte < ASCII_MAX ? byte : SURROGATE_BASE + byte)
}

/**
 * Whether the code unit at `i` is a byte this module smuggled in.
 *
 * The sentinels are lone low surrogates, and a low surrogate that follows
 * a high one is half of an ordinary non-BMP character (`𐂀` is
 * U+D800 U+DC80) that must be encoded as itself.
 */
function isByteSentinel(text: string, i: number): boolean {
  const code = text.charCodeAt(i)
  if (code < SURROGATE_LOW || code > SURROGATE_HIGH) return false
  if (i === 0) return true
  const before = text.charCodeAt(i - 1)
  return before < HIGH_SURROGATE_LOW || before > HIGH_SURROGATE_HIGH
}

/**
 * Encode shell text for output, byte escapes included.
 *
 * Every place the shell turns its own text into bytes goes through here,
 * because a string that reached it from `byteChar` holds a lone surrogate
 * that `TextEncoder` would write as U+FFFD.
 */
export function encodeText(text: string): Uint8Array {
  let first = -1
  for (let i = 0; i < text.length; i++) {
    if (isByteSentinel(text, i)) {
      first = i
      break
    }
  }
  if (first === -1) return ENC.encode(text)
  const parts: Uint8Array[] = []
  let run = ''
  for (let i = 0; i < text.length; i++) {
    if (isByteSentinel(text, i)) {
      if (run !== '') {
        parts.push(ENC.encode(run))
        run = ''
      }
      parts.push(new Uint8Array([text.charCodeAt(i) - SURROGATE_BASE]))
    } else {
      run += text.charAt(i)
    }
  }
  if (run !== '') parts.push(ENC.encode(run))
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Read bytes back as shell text, the inverse of `encodeText`.
 *
 * Valid UTF-8 comes back as its characters and every other byte as its
 * surrogate escape, the stand-in `byteChar` makes, so the text round-trips
 * to exactly the bytes it was read from. `TextDecoder`'s replacement cannot:
 * one invalid byte becomes U+FFFD, three bytes wide, and every byte offset
 * counted back past it runs ahead of GNU's.
 */
export function decodeText(raw: Uint8Array): string {
  try {
    return DECODER.decode(raw)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
  }
  const parts: string[] = []
  const units = new Uint16Array(Math.min(raw.length, 8192))
  let used = 0
  for (let i = 0; i < raw.length;) {
    const byte = raw[i] ?? 0
    const second = raw[i + 1] ?? 0
    const third = raw[i + 2] ?? 0
    const fourth = raw[i + 3] ?? 0
    let code = byte < ASCII_MAX ? byte : SURROGATE_BASE + byte
    let width = 1
    // Reject overlong encodings, surrogate code points and values above
    // U+10FFFF. An invalid sequence escapes only its first byte, just as
    // Python's surrogateescape does, then retries at the following byte.
    if (byte >= 0xc2 && byte <= 0xdf && second >= 0x80 && second <= 0xbf) {
      code = ((byte & 0x1f) << 6) | (second & 0x3f)
      width = 2
    } else if (
      byte >= 0xe0 &&
      byte <= 0xef &&
      second >= (byte === 0xe0 ? 0xa0 : 0x80) &&
      second <= (byte === 0xed ? 0x9f : 0xbf) &&
      third >= 0x80 &&
      third <= 0xbf
    ) {
      code = ((byte & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      width = 3
    } else if (
      byte >= 0xf0 &&
      byte <= 0xf4 &&
      second >= (byte === 0xf0 ? 0x90 : 0x80) &&
      second <= (byte === 0xf4 ? 0x8f : 0xbf) &&
      third >= 0x80 &&
      third <= 0xbf &&
      fourth >= 0x80 &&
      fourth <= 0xbf
    ) {
      code = ((byte & 7) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
      width = 4
    }
    if (code > 0xffff) {
      code -= 0x10000
      units[used++] = 0xd800 + (code >> 10)
      units[used++] = 0xdc00 + (code & 0x3ff)
    } else {
      units[used++] = code
    }
    i += width
    if (used >= units.length - 1) {
      parts.push(String.fromCharCode(...units.subarray(0, used)))
      used = 0
    }
  }
  if (used > 0) parts.push(String.fromCharCode(...units.subarray(0, used)))
  return parts.join('')
}

/**
 * Whether the environment names a UTF-8 locale, as setlocale reads it.
 *
 * POSIX takes the character type from the first of `LC_ALL`, `LC_CTYPE` and
 * `LANG` that is set and not empty, so `LC_ALL=C` outranks `LANG=C.UTF-8`. A
 * name is `language[_territory][.codeset][@modifier]`, and glibc compares the
 * codeset with case and punctuation dropped, so `C.UTF-8`, `en_US.utf8` and
 * `de_DE.UTF-8@euro` all name UTF-8. Every UTF-8 name counts as installed,
 * where glibc falls back to the C locale for one it lacks. Mirrors Python's
 * `utf8_locale`.
 */
export function utf8Locale(env: Readonly<Record<string, string>> | undefined): boolean {
  for (const name of LOCALE_VARS) {
    const value = env?.[name] ?? ''
    if (value !== '') {
      const codeset = value.split('@')[0]?.split('.').slice(1).join('.') ?? ''
      return codeset.toLowerCase().replace(/[^a-z0-9]/g, '') === UTF8_CODESET
    }
  }
  return false
}

/**
 * The same bytes as a string of one character per byte.
 *
 * A command that runs in GNU's C locale (grep, sed, awk, tr, expr) counts,
 * matches and indexes bytes, not characters: `.` matches one byte, `length`
 * counts bytes, and a match may end inside a character. All of that follows
 * from running on this representation and converting only at the command's
 * edges, where a typed `é`, its `$'\xc3\xa9'` spelling and the file's own
 * bytes all arrive as the same two characters. Mirrors Python's `byte_view`.
 *
 * Under a UTF-8 locale (`utf8`) grep, sed and expr count, match and index
 * characters instead, so the view is the text itself: a byte that is no part
 * of a character stays its surrogate escape, one element of its own, as it
 * does in glibc's matcher.
 */
export function byteView(value: string | Uint8Array, utf8 = false): string {
  if (utf8) return typeof value === 'string' ? value : decodeText(value)
  const bytes = typeof value === 'string' ? encodeText(value) : value
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += VIEW_CHUNK)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + VIEW_CHUNK)))
  return parts.join('')
}

/**
 * The bytes a byte view stands for, the inverse of `byteView`. An invalid
 * sequence or half a character comes back as itself, which is what GNU
 * writes. Under `utf8` the view is the text itself.
 */
export function fromByteView(view: string, utf8 = false): Uint8Array {
  if (utf8) return encodeText(view)
  const out = new Uint8Array(view.length)
  for (let at = 0; at < view.length; at++) {
    const byte = view.charCodeAt(at)
    if (byte > BYTE_MASK) throw new RangeError('byte view contains a non-byte character')
    out[at] = byte
  }
  return out
}

/** A byte view as shell text again, for a path or a nested command line. */
export function textView(view: string, utf8 = false): string {
  return utf8 ? view : decodeText(fromByteView(view))
}
