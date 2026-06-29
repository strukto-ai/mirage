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

export function parseN(n: string | null): [number, boolean] {
  if (n === null) return [10, false]
  if (n.startsWith('+')) return [Number.parseInt(n.slice(1), 10), true]
  return [Number.parseInt(n, 10), false]
}

// GNU-style validation for head/tail -n/-c. Mirrors Python's int() raising on
// a non-numeric value; returns the error line (with the bad value) or null.
export function numberFlagError(
  cmd: string,
  nRaw: string | null,
  cRaw: string | null,
): string | null {
  if (nRaw !== null && !/^[+-]?\d+$/.test(nRaw)) {
    return `${cmd}: invalid number of lines: '${nRaw}'\n`
  }
  if (cRaw !== null && !/^[+-]?\d+$/.test(cRaw)) {
    return `${cmd}: invalid number of bytes: '${cRaw}'\n`
  }
  return null
}

export function tailBytes(
  data: Uint8Array,
  lines: number,
  bytesMode: number | null = null,
  plusMode = false,
): Uint8Array {
  if (bytesMode !== null) {
    const targetBytes = Math.abs(bytesMode)
    if (targetBytes === 0) return new Uint8Array(0)
    const start = Math.max(0, data.byteLength - targetBytes)
    return data.slice(start)
  }
  const parts = splitLines(data)
  const trimmed =
    parts.length > 0 && parts[parts.length - 1]?.byteLength === 0 ? parts.slice(0, -1) : parts
  let selected: Uint8Array[]
  if (plusMode) {
    selected = trimmed.slice(Math.max(0, lines - 1))
  } else {
    const targetLines = Math.abs(lines)
    if (targetLines === 0) return new Uint8Array(0)
    selected = trimmed.slice(-targetLines)
  }
  if (selected.length === 0) return new Uint8Array(0)
  const result = joinWith(selected, 0x0a)
  if (data.byteLength > 0 && data[data.byteLength - 1] === 0x0a) {
    const out = new Uint8Array(result.byteLength + 1)
    out.set(result, 0)
    out[result.byteLength] = 0x0a
    return out
  }
  return result
}

function splitLines(data: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] === 0x0a) {
      parts.push(data.subarray(start, i))
      start = i + 1
    }
  }
  parts.push(data.subarray(start))
  return parts
}

function joinWith(parts: readonly Uint8Array[], sep: number): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0)
  let total = 0
  for (const p of parts) total += p.byteLength
  total += parts.length - 1
  const out = new Uint8Array(total)
  let offset = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === undefined) continue
    out.set(p, offset)
    offset += p.byteLength
    if (i < parts.length - 1) {
      out[offset] = sep
      offset += 1
    }
  }
  return out
}

export function countNewlines(data: Uint8Array): number {
  let n = 0
  for (let i = 0; i < data.byteLength; i++) if (data[i] === 0x0a) n += 1
  return n
}
