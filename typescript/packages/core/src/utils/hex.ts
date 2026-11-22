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

const BYTE_HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, '0'),
)

/**
 * The bytes as lowercase hex, two digits a byte. Joined into one flat string:
 * one grown by `+=` stays a tree of its pieces, about 825 bytes for a 20-byte
 * object id where the flat one takes 65, and a checkout keeps one per file.
 */
export function toHex(bytes: Uint8Array): string {
  const digits = new Array<string>(bytes.length)
  for (let i = 0; i < bytes.length; i++) digits[i] = BYTE_HEX[bytes[i] ?? 0] ?? '00'
  return digits.join('')
}

/** The bytes a run of hex digits spells, two digits a byte. */
export function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16)
  return out
}
