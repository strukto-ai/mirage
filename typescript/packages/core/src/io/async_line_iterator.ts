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

import { abortable } from '../workspace/abort.ts'
import { CachableAsyncIterator } from './cachable_iterator.ts'
import { YieldBudget } from './yield_budget.ts'
import { chunks } from './cooperative.ts'

const NEWLINE = 0x0a

export class AsyncLineIterator implements AsyncIterableIterator<Uint8Array> {
  private readonly source: AsyncIterator<Uint8Array>
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private exhausted = false
  private readonly budget = new YieldBudget()
  private linesSinceCheck = 0
  private pulling = false

  constructor(private readonly input: AsyncIterable<Uint8Array> | AsyncIterator<Uint8Array>) {
    const s = this.input as AsyncIterable<Uint8Array>
    if (typeof s[Symbol.asyncIterator] === 'function') {
      this.source = chunks(s)
    } else {
      this.source = chunks({
        [Symbol.asyncIterator]: () => this.input as AsyncIterator<Uint8Array>,
      })
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

  async readline(signal?: AbortSignal): Promise<Uint8Array | null> {
    try {
      // A buffered line is handed out without a pull, so the signal is
      // checked here as well, on both sides of the yield.
      signal?.throwIfAborted()
      // Amortize clock reads on short-line workloads; chunk pulls also check.
      if (++this.linesSinceCheck >= 64) {
        this.linesSinceCheck = 0
        const pending = this.budget.run()
        if (pending !== undefined) {
          await pending
          signal?.throwIfAborted()
        }
      }
      const idx = this.buf.indexOf(NEWLINE)
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx)
        this.buf = this.buf.subarray(idx + 1)
        return line
      }
    } catch (error) {
      await this.close()
      throw error
    }
    const [line, found] = await this.readDelimited(NEWLINE, signal)
    return found || line.byteLength > 0 ? line : null
  }

  // The stdin buffer survives individual builtins; cancellation belongs to each read.
  private check(signal?: AbortSignal): Promise<void> | undefined {
    signal?.throwIfAborted()
    const pending = this.budget.run()
    if (pending !== undefined) return pending.then(() => signal?.throwIfAborted())
  }

  private async close(): Promise<void> {
    this.exhausted = true
    this.buf = new Uint8Array(0)
    // A return queued behind a pull that never settles would hang the
    // abort itself; that one is not awaited.
    const closing = this.source.return?.()
    if (closing !== undefined) {
      if (this.pulling) void closing.catch(() => undefined)
      else await closing
    }
    // The discard closes the same producer, so behind a stalled pull it
    // is not awaited either; `discard` never rejects.
    if (this.input instanceof CachableAsyncIterator) {
      const discarding = this.input.discard()
      if (this.pulling) void discarding
      else await discarding
    }
  }

  private async pull(signal?: AbortSignal): Promise<IteratorResult<Uint8Array>> {
    // Left set when the pull fails: close() reads it to know the source
    // is still busy with the pull the abort abandoned.
    this.pulling = true
    const result = await abortable(this.source.next(), signal)
    this.pulling = false
    return result
  }

  private async readDelimited(
    delim: number,
    signal?: AbortSignal,
  ): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    const parts: Uint8Array[] = []
    try {
      for (;;) {
        const pending = this.check(signal)
        if (pending !== undefined) await pending
        const idx = this.buf.indexOf(delim)
        if (idx >= 0) {
          const tail = this.buf.subarray(0, idx)
          this.buf = this.buf.subarray(idx + 1)
          return [parts.length === 0 ? tail : join([...parts, tail]), true]
        }
        if (this.buf.byteLength > 0) parts.push(this.buf)
        this.buf = new Uint8Array(0)
        if (this.exhausted) return [join(parts), false]
        // Raced, not just checked between pulls: a stalled stdin must lose
        // to the read's own signal, or the reader outlives the caller.
        const result = await this.pull(signal)
        if (result.done === true) this.exhausted = true
        else this.buf = copyOf(result.value)
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /**
   * Read up to (not including) `delim`, or to EOF. Returns the bytes and
   * whether the delimiter was found (false means EOF, which `read`/
   * `mapfile` report as status 1).
   */
  async readUntil(
    delim: number,
    signal?: AbortSignal,
  ): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    const [data, found] = await this.readDelimited(delim, signal)
    return [copyOf(data), found]
  }

  /**
   * Read at most `count` characters, stopping early at `delim` (null
   * reads through delimiters). `read -n` is the delimited form, `read
   * -N` the null one. The delimiter is consumed and not returned.
   * Returns the bytes and whether the read ended on its own terms
   * rather than EOF.
   *
   * Characters, not bytes: bash counts them in the shell's locale, so
   * `read -n 1` on `éx` assigns `é` and leaves `x`. Counting bytes
   * would hand back half a character and leave the other half to
   * corrupt the next read.
   */
  async readChars(
    count: number,
    delim: number | null,
    signal?: AbortSignal,
  ): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    try {
      let out: Uint8Array<ArrayBuffer> = new Uint8Array(0)
      let taken = 0
      while (taken < count) {
        const pending = this.check(signal)
        if (pending !== undefined) await pending
        // One pull can split a character across chunks, so top the buffer
        // up to the widest one before reading its first byte as a whole.
        if (this.buf.byteLength < 4 && !this.exhausted) {
          const result = await this.pull(signal)
          if (result.done === true) this.exhausted = true
          else this.buf = concat2(this.buf, result.value)
          continue
        }
        if (this.buf.byteLength === 0) return [copyOf(out), false]
        if (delim !== null && this.buf[0] === delim) {
          this.buf = this.buf.subarray(1)
          return [copyOf(out), true]
        }
        const width = charWidth(this.buf)
        out = concat2(out, this.buf.subarray(0, width))
        this.buf = this.buf.subarray(width)
        taken++
      }
      return [copyOf(out), true]
    } catch (error) {
      await this.close()
      throw error
    }
  }
}

/**
 * How many bytes `data`'s first character spans, decoded as UTF-8.
 *
 * Always at least one and never more than what is there, so a caller
 * stepping by this never splits a character and never stalls. Bytes that
 * decode to one replacement character answer 1, which is what a
 * fatal:false TextDecoder makes of them: a stray continuation byte, a
 * lead the encoding never uses, and a sequence cut short by a byte that
 * cannot continue it.
 */
export function charWidth(data: Uint8Array): number {
  const lead = data[0] ?? 0
  if (lead < 0xc2 || lead >= 0xf5) return 1
  const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
  const limit = Math.min(width, data.byteLength)
  for (let i = 1; i < limit; i++) {
    const byte = data[i] ?? 0
    if (byte < 0x80 || byte >= 0xc0) return i
  }
  return limit
}

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.byteLength === 0) return copyOf(b)
  if (b.byteLength === 0) return copyOf(a)
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function copyOf(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.byteLength)
  out.set(buf, 0)
  return out
}
