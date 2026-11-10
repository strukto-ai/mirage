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

const MEBIBYTE = 1 << 20
const WASM_PAGE_BYTES = 1 << 16
const WASM_HEADER_BYTES = 8
const MEMORY_SECTION = 5
const HAS_MAXIMUM = 1

/** How many differently limited compilations of a module stay ready. */
export const KEPT_COMPILATIONS = 4

/**
 * The pages a limit of `bytes` allows, rounded down to whole mebibytes so runs
 * with nearly the same room share a compilation.
 *
 * @param bytes - the limit.
 */
export function pagesFor(bytes: number): number {
  return Math.floor(bytes / MEBIBYTE) * (MEBIBYTE / WASM_PAGE_BYTES)
}

function readLeb(bytes: Uint8Array, at: number): [number, number] {
  let value = 0
  let shift = 0
  let next = at
  for (;;) {
    const byte = bytes[next++] ?? 0
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if ((byte & 0x80) === 0) return [value, next]
  }
}

function leb(value: number): number[] {
  const out: number[] = []
  let rest = value
  do {
    const byte = rest % 128
    rest = Math.floor(rest / 128)
    out.push(rest > 0 ? byte | 0x80 : byte)
  } while (rest > 0)
  return out
}

/**
 * A module's bytes with the memory it defines held to `pages` pages, its own
 * minimum being the least it can start on. The WebAssembly API takes no limit
 * for a memory a module defines itself, as wasmtime's `Store` limits do, so
 * the limit goes in the module.
 *
 * @param bytes - the module.
 * @param pages - the most its linear memory may grow to.
 */
export function capMemory(bytes: Uint8Array, pages: number): Uint8Array {
  let at = WASM_HEADER_BYTES
  while (at < bytes.length) {
    const [size, body] = readLeb(bytes, at + 1)
    const end = body + size
    if (bytes[at] === MEMORY_SECTION) {
      const [count, flagsAt] = readLeb(bytes, body)
      if (count !== 1) return bytes
      const [least] = readLeb(bytes, flagsAt + 1)
      const flags = (bytes[flagsAt] ?? 0) | HAS_MAXIMUM
      const section = [count, flags, ...leb(least), ...leb(Math.max(least, pages))]
      return new Uint8Array([
        ...bytes.subarray(0, at),
        MEMORY_SECTION,
        ...leb(section.length),
        ...section,
        ...bytes.subarray(end),
      ])
    }
    at = end
  }
  return bytes
}
