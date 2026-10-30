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

import { setSpoolFactory, type SpoolStore } from '@struktoai/mirage-core/io/spool'

/**
 * A page's spool scratch: spilled bytes as fixed blocks of Blob, which the
 * browser holds outside the JavaScript heap and may page to disk, so a spool
 * past its memory limit no longer grows the heap. A write past a block's
 * start rebuilds only the blocks it touches. Mirrors Node's spool store.
 */
function createStore(): Promise<SpoolStore> {
  const BLOCK = 256 * 1024
  const blocks: Blob[] = []
  let length = 0
  return Promise.resolve({
    async write(at, data) {
      let offset = 0
      while (offset < data.length) {
        const index = Math.floor((at + offset) / BLOCK)
        const start = (at + offset) % BLOCK
        const count = Math.min(BLOCK - start, data.length - offset)
        const held = blocks[index]
        const old = held === undefined ? new Uint8Array() : new Uint8Array(await held.arrayBuffer())
        const next = new Uint8Array(Math.max(old.length, start + count))
        next.set(old)
        next.set(data.subarray(offset, offset + count), start)
        blocks[index] = new Blob([next])
        offset += count
      }
      length = Math.max(length, at + data.length)
    },
    async read(offset, size) {
      const end = Math.min(length, offset + size)
      if (end <= offset) return new Uint8Array()
      const first = Math.floor(offset / BLOCK)
      const window = new Blob(blocks.slice(first, Math.floor((end - 1) / BLOCK) + 1))
      return new Uint8Array(
        await window.slice(offset - first * BLOCK, end - first * BLOCK).arrayBuffer(),
      )
    },
    body() {
      return Promise.resolve(new Blob(blocks))
    },
    close() {
      blocks.length = 0
      length = 0
      return Promise.resolve()
    },
  })
}

setSpoolFactory(createStore)
