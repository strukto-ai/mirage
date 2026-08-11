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
