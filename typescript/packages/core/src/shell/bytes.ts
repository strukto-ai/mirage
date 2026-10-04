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
