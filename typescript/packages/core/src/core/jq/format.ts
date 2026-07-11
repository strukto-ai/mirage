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

export const JQ_EMPTY: unique symbol = Symbol('JQ_EMPTY')

const ENC = new TextEncoder()

function formatOne(value: unknown, raw: boolean, compact: boolean): Uint8Array {
  if (raw && typeof value === 'string') return ENC.encode(value + '\n')
  const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  return ENC.encode(json + '\n')
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

export function formatJqOutput(
  result: unknown,
  raw: boolean,
  compact: boolean,
  spread: boolean,
): Uint8Array {
  if (result === JQ_EMPTY) return new Uint8Array(0)
  if (spread && Array.isArray(result)) {
    const parts: Uint8Array[] = []
    for (const item of result) parts.push(formatOne(item, raw, compact))
    return concatBytes(parts)
  }
  return formatOne(result, raw, compact)
}
