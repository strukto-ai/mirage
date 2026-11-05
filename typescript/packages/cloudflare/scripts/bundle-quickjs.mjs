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

// quickjs-ng's WASI build, the release CI's QuickJS runs (QUICKJS_BUILD in
// the workflows), checked against its digest: the copy kept here, the one
// under MIRAGE_QUICKJS_HOME, or the release's own.
//
// The package ships it with its memory held to MAX_PAGES. A guest past it
// fails to grow, and qjs raises its own `out of memory`, which a script can
// catch, where an isolate past its 128 MB would be reset. qjs's
// --memory-limit counts no allocation on WASI, so the cap is the memory's.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 'v0.16.2'
const DIGEST = 'd2939e98c808e8b9f4164cd0d7b0398cbc0121ddf52862bcd92157d923e461cc'
const RELEASE = `https://github.com/quickjs-ng/quickjs/releases/download/${VERSION}/qjs-wasi.wasm`
// 64 KiB pages: 64 MiB, half the isolate's memory.
const MAX_PAGES = 1024

const output = new URL('../src/generated/', import.meta.url)
// The release's bytes are kept under a name the package does not ship.
const kept = new URL(`qjs-wasi-${VERSION}.bin`, output)
const target = new URL('qjs-wasi.wasm', output)
const sound = (bytes) => createHash('sha256').update(bytes).digest('hex') === DIGEST

const leb = (value) => {
  const out = []
  let rest = value
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest !== 0) byte |= 0x80
    out.push(byte)
  } while (rest !== 0)
  return out
}

const readLeb = (bytes, at) => {
  let [value, shift, i] = [0, 0, at]
  for (;;) {
    const byte = bytes[i++]
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if ((byte & 0x80) === 0) return [value, i]
  }
}

/** The module with its one memory's maximum set to `pages`. */
function capMemory(bytes, pages) {
  const parts = [bytes.subarray(0, 8)]
  let [at, capped] = [8, false]
  while (at < bytes.length) {
    const [size, body] = readLeb(bytes, at + 1)
    const end = body + size
    if (bytes[at] === 5) {
      const [count, first] = readLeb(bytes, body)
      const flags = bytes[first]
      if (count !== 1 || (flags & ~1) !== 0)
        throw new Error('qjs-wasi.wasm has no single plain memory')
      const [min] = readLeb(bytes, first + 1)
      if (min > pages) throw new Error(`qjs-wasi.wasm starts with ${min} pages, past ${pages}`)
      const content = [1, 1, ...leb(min), ...leb(pages)]
      parts.push(Uint8Array.from([5, ...leb(content.length), ...content]))
      capped = true
    } else parts.push(bytes.subarray(at, end))
    at = end
  }
  if (!capped) throw new Error('qjs-wasi.wasm defines no memory')
  return Buffer.concat(parts)
}

mkdirSync(output, { recursive: true })
const home = process.env.MIRAGE_QUICKJS_HOME
const local = [kept, ...(home ? [join(home, 'qjs-wasi.wasm')] : [])].find(
  (path) => existsSync(path) && sound(readFileSync(path)),
)
let bytes
if (local === undefined) {
  const response = await fetch(RELEASE)
  if (!response.ok) throw new Error(`${RELEASE}: ${response.status} ${response.statusText}`)
  bytes = new Uint8Array(await response.arrayBuffer())
  if (!sound(bytes)) throw new Error(`${RELEASE} is not quickjs-ng ${VERSION}'s qjs-wasi.wasm`)
} else bytes = readFileSync(local)
if (local !== kept) writeFileSync(kept, bytes)
const capped = capMemory(bytes, MAX_PAGES)
new WebAssembly.Module(capped)
writeFileSync(target, capped)
