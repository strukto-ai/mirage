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

const NEWLINE = 0x0a

export class AsyncLineIterator implements AsyncIterableIterator<Uint8Array> {
  private readonly source: AsyncIterator<Uint8Array>
  private buf: Uint8Array = new Uint8Array(0)
  private exhausted = false

  constructor(source: AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>) {
    const s = source as AsyncIterable<Uint8Array>
    if (typeof s[Symbol.asyncIterator] === 'function') {
      this.source = s[Symbol.asyncIterator]()
    } else {
      this.source = source as AsyncIterator<Uint8Array>
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const line = await this.readline()
    if (line === null) return { done: true, value: undefined }
    return { done: false, value: line }
  }

  async readline(): Promise<Uint8Array | null> {
    while (indexOf(this.buf, NEWLINE) < 0) {
      if (this.exhausted) {
        if (this.buf.byteLength > 0) {
          const remaining = this.buf
          this.buf = new Uint8Array(0)
          return remaining
        }
        return null
      }
      const result = await this.source.next()
      if (result.done === true) {
        this.exhausted = true
        continue
      }
      this.buf = concat2(this.buf, result.value)
    }
    const idx = indexOf(this.buf, NEWLINE)
    const line = this.buf.subarray(0, idx)
    this.buf = this.buf.subarray(idx + 1)
    return line
  }
}

function indexOf(buf: Uint8Array, byte: number): number {
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] === byte) return i
  }
  return -1
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b
  if (b.byteLength === 0) return a
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}
