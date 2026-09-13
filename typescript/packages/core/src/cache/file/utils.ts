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

import { md5Hex, md5HexAsync } from '../../utils/hash.ts'

export function parseLimit(limit: string | number): number {
  if (typeof limit === 'number') return limit
  const s = limit.trim().toUpperCase()
  const suffixes: [string, number][] = [
    ['GB', 1 << 30],
    ['MB', 1 << 20],
    ['KB', 1 << 10],
  ]
  for (const [suffix, mult] of suffixes) {
    if (s.endsWith(suffix)) return parseInt(s.slice(0, -suffix.length), 10) * mult
  }
  return parseInt(s, 10)
}

export function defaultFingerprint(data: Uint8Array): string {
  return md5Hex(data)
}

let fingerprintHasher: (data: Uint8Array) => Promise<string> = md5HexAsync

/** Runtime packages install their native implementation, as with compression codecs. */
export function registerFingerprintHasher(hasher: (data: Uint8Array) => Promise<string>): void {
  fingerprintHasher = hasher
}

export async function defaultFingerprintAsync(data: Uint8Array): Promise<string> {
  return fingerprintHasher(data)
}

/**
 * Escape a literal for use inside a redis MATCH pattern.
 *
 * Cache keys are mount paths, and a path may legitimately contain the glob
 * metacharacters redis SCAN interprets, so a prefix like `/data[1]/` would
 * otherwise match nothing (or the wrong keys).
 */
export function globEscape(literal: string): string {
  let out = ''
  for (const ch of literal) {
    if (ch === '*' || ch === '?' || ch === '[' || ch === ']' || ch === '\\') out += '\\'
    out += ch
  }
  return out
}
