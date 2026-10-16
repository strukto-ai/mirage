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

import { findBytes } from '../utils/bytes.ts'
import { abortable } from '../utils/abort.ts'
import { YieldBudget } from './yield_budget.ts'
import { chunks } from './cooperative.ts'
import { type ByteSource, DeviceInput, type PipeEnd, PipeStream } from './types.ts'
import type { PathSpec } from '../types.ts'

const NEWLINE = 0x0a
const BYTE_VIEW = new TextDecoder('latin1')

/**
 * The read end an `exec` keeps on a live pipe (`exec 3<"$1"`). It holds the
 * pipe, not the name it was opened by. Each read takes a stream of its own
 * under the reading command's signal and closes it after one chunk, so a read
 * that gives up (`timeout`) leaves the rest to the next read. Mirrors
 * Python's PipeInput.
 */
export class PipeInput implements AsyncIterableIterator<Uint8Array> {
  /** `path` is the pipe's own (`/dev/fd/N`); `signal` gives each read its reader's. */
  constructor(
    readonly path: PathSpec,
    private readonly end: PipeEnd,
    private readonly signal: () => AbortSignal | undefined,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const iterator = this.end.stream(this.path, this.signal())[Symbol.asyncIterator]()
    try {
      return await iterator.next()
    } finally {
      await iterator.return?.()
    }
  }
}

export class AsyncLineIterator implements AsyncIterableIterator<Uint8Array> {
  private readonly source: AsyncIterator<Uint8Array>
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private pulled = 0
  private exhausted = false
  private readonly budget = new YieldBudget()
  private linesSinceCheck = 0
  private pulling = false
  private started = false
  private searchedBuffer: ArrayBufferLike | null = null
  private searchedOffset = 0
  private searchedText = ''
  private searchedNeedles: readonly string[] | null = null
  private searchedFolded = false
  private hits: number[] = []
  private unskippedAttempts = 0

  constructor(private readonly input: ByteSource | AsyncIterator<Uint8Array>) {
    const s = this.input as AsyncIterable<Uint8Array>
    if (this.input instanceof Uint8Array) {
      this.source = chunks(this.input)
    } else if (this.input instanceof PipeInput) {
      this.source = this.input
    } else if (typeof s[Symbol.asyncIterator] === 'function') {
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

  get position(): number {
    return this.pulled - this.buf.byteLength
  }

  unread(data: Uint8Array): void {
    this.buf = concat2(data, this.buf)
  }

  get loaded(): number {
    return this.pulled
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const line = await this.readline()
    if (line === null) return { done: true, value: undefined }
    return { done: false, value: line }
  }

  /**
   * Peek at complete buffered records without pulling or consuming input;
   * with `needles`, only the records holding one, as `skipNonmatchingLines`
   * reads them.
   */
  bufferedLines(
    eol = NEWLINE,
    limit = 31,
    needles: readonly string[] | null = null,
    ignoreCase = false,
  ): Uint8Array[] {
    const records: Uint8Array[] = []
    let start = 0
    while (records.length < limit) {
      const end = this.buf.indexOf(eol, start)
      if (end < 0) break
      const record = this.buf.subarray(start, end)
      start = end + 1
      if (needles !== null) {
        const text = BYTE_VIEW.decode(record)
        const view = ignoreCase ? text.toLowerCase() : text
        if (!needles.some((needle) => view.includes(needle))) continue
      }
      records.push(record)
    }
    return records
  }

  /** Consume buffered empty lines without pulling more input. */
  skipEmptyLines(limit = Infinity, eol = NEWLINE): number {
    let count = 0
    while (count < limit && this.buf[count] === eol) count++
    this.buf = this.buf.subarray(count)
    return count
  }

  /**
   * Skip complete buffered records before a possible match of any of the
   * nonempty byte-view literals, none of which holds the delimiter; under
   * `ignoreCase` they are lowercase and the view is lowercased. Leave the
   * candidate and any unfinished record for readline and readUntil, which
   * join transport boundaries before decoding. Return the skipped record
   * and byte counts without pulling more input. Each needle's next hit is
   * kept until the buffer is refilled, so the calls between two pulls
   * search it once, however the hits interleave. The single-byte view
   * preserves ASCII and byte positions; it is never used for Unicode
   * matching or output.
   */
  skipNonmatchingLines(
    needles: readonly string[],
    ignoreCase = false,
    delimiter = NEWLINE,
  ): [number, number] {
    if (this.buf.length === 0) return [0, 0]
    if (
      this.searchedBuffer !== this.buf.buffer ||
      this.searchedNeedles !== needles ||
      this.searchedFolded !== ignoreCase
    ) {
      const text = BYTE_VIEW.decode(this.buf)
      this.searchedBuffer = this.buf.buffer
      this.searchedOffset = this.buf.byteOffset
      this.searchedText = ignoreCase ? text.toLowerCase() : text
      this.searchedNeedles = needles
      this.searchedFolded = ignoreCase
      this.hits = needles.map(() => -1)
      this.unskippedAttempts = 0
    }
    // Dense matches skip nothing; stop trying until the next pull.
    if (this.unskippedAttempts >= 8) return [0, 0]
    const start = this.buf.byteOffset - this.searchedOffset
    const text = this.searchedText
    let hit = text.length
    needles.forEach((needle, index) => {
      let at = this.hits[index] ?? -1
      if (at < start) {
        at = text.indexOf(needle, start)
        if (at < 0) at = text.length
        this.hits[index] = at
      }
      hit = Math.min(hit, at)
    })
    const end = text.lastIndexOf(String.fromCharCode(delimiter), hit - 1) + 1
    const size = Math.max(0, end - start)
    this.unskippedAttempts = size === 0 ? this.unskippedAttempts + 1 : 0
    let count = 0
    for (let at = 0; at < size; at++) if (this.buf[at] === delimiter) count++
    this.buf = this.buf.subarray(size)
    return [count, size]
  }

  async readline(signal?: AbortSignal, eol = NEWLINE): Promise<Uint8Array | null> {
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
      const idx = this.buf.indexOf(eol)
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx)
        this.buf = this.buf.subarray(idx + 1)
        return line
      }
    } catch (error) {
      await this.failed(error)
      throw error
    }
    const [line, found] = await this.readDelimited(eol, signal)
    return found || line.byteLength > 0 ? line : null
  }

  // The stdin buffer survives individual builtins; cancellation belongs to each read.
  /** Close the source and drop what it buffered, for input a failed line abandoned. */
  discard(): Promise<void> {
    return this.close()
  }

  /**
   * Read what the source has left into the buffer, for a descriptor that
   * outlives its pipe: reads go on from memory. Mirrors Python's load_rest.
   */
  async loadRest(): Promise<void> {
    try {
      while (!this.exhausted) {
        const pending = this.check()
        if (pending !== undefined) await pending
        const result = await this.pull()
        if (result.done === true) this.exhausted = true
        else this.buf = concat2(this.buf, result.value)
      }
    } catch (error) {
      await this.failed(error)
      throw error
    }
  }

  /**
   * Close the source after a failed read, unless it was a reader's own abort
   * on a pipe an `exec` keeps, which stays open with `taken`, what the read
   * had taken, put back. Mirrors Python's _failed.
   */
  private async failed(error: unknown, taken: readonly Uint8Array[] = []): Promise<void> {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    if (this.input instanceof PipeInput && aborted) {
      if (taken.length > 0) this.buf = join([...taken, this.buf])
      return
    }
    await this.close()
  }

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
    if (!this.started) {
      const original = this.input as AsyncIterator<Uint8Array>
      await original.return?.()
    }
  }

  private async pull(signal?: AbortSignal): Promise<IteratorResult<Uint8Array>> {
    // Left set when the pull fails: close() reads it to know the source
    // is still busy with the pull the abort abandoned.
    this.pulling = true
    this.started = true
    const result = await abortable(this.source.next(), signal)
    this.pulling = false
    if (result.done !== true) this.pulled += result.value.byteLength
    return result
  }

  private async readDelimited(
    delim: number | Uint8Array,
    signal?: AbortSignal,
  ): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    const parts: Uint8Array[] = []
    const width = typeof delim === 'number' ? 1 : delim.length
    if (width === 0) throw new Error('empty separator')
    try {
      for (;;) {
        const pending = this.check(signal)
        if (pending !== undefined) await pending
        const idx = typeof delim === 'number' ? this.buf.indexOf(delim) : findBytes(this.buf, delim)
        if (idx >= 0) {
          const tail = this.buf.subarray(0, idx)
          this.buf = this.buf.subarray(idx + width)
          return [parts.length === 0 ? tail : join([...parts, tail]), true]
        }
        if (this.exhausted) {
          parts.push(this.buf)
          this.buf = new Uint8Array()
          return [join(parts), false]
        }
        const keep = Math.min(width - 1, this.buf.length)
        const cut = this.buf.length - keep
        if (cut > 0) parts.push(this.buf.subarray(0, cut))
        this.buf = this.buf.subarray(cut)
        // Raced, not just checked between pulls: a stalled stdin must lose
        // to the read's own signal, or the reader outlives the caller.
        const result = await this.pull(signal)
        if (result.done === true) this.exhausted = true
        else this.buf = concat2(this.buf, result.value)
      }
    } catch (error) {
      await this.failed(error, parts)
      throw error
    }
  }

  /**
   * Read up to (not including) `delim`, or to EOF. Returns the bytes and
   * whether the delimiter was found (false means EOF, which `read`/
   * `mapfile` report as status 1).
   */
  async readUntil(
    delim: number | Uint8Array,
    signal?: AbortSignal,
  ): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
    const [data, found] = await this.readDelimited(delim, signal)
    return [copyOf(data), found]
  }

  /**
   * Whether another byte follows, consuming nothing. Pulls the source's next
   * chunk only when nothing is buffered, so a line still arriving never holds
   * the answer up. Mirrors Python's peek.
   */
  async peek(signal?: AbortSignal): Promise<boolean> {
    try {
      while (this.buf.byteLength === 0) {
        if (this.exhausted) return false
        const pending = this.check(signal)
        if (pending !== undefined) await pending
        const result = await this.pull(signal)
        if (result.done === true) this.exhausted = true
        else this.buf = copyOf(result.value)
      }
      return true
    } catch (error) {
      await this.failed(error)
      throw error
    }
  }

  /** Hand over what is buffered, else the source's next chunk; null at end of input. */
  async readChunk(): Promise<Uint8Array | null> {
    if (this.buf.byteLength > 0) {
      const data = this.buf
      this.buf = new Uint8Array(0)
      return data
    }
    if (this.exhausted) return null
    try {
      const pending = this.check()
      if (pending !== undefined) await pending
      const result = await this.pull()
      if (result.done === true) {
        this.exhausted = true
        return null
      }
      return result.value
    } catch (error) {
      await this.failed(error)
      throw error
    }
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
    let out: Uint8Array<ArrayBuffer> = new Uint8Array(0)
    try {
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
      await this.failed(error, [out])
      throw error
    }
  }
}

/**
 * Standard input that the commands of one group, loop or shell read in
 * turn, as bash's all read one open descriptor.
 *
 * What one command reads the next does not see again: `read` takes its
 * line off `lines` and leaves the rest buffered there, and any other
 * command iterates this object for that rest, then for what the source
 * still holds. It has no `return`, so a command that stops early never
 * closes the source a later command may still read; whoever opened the
 * source closes it, and a failed line discards it.
 */
export class SharedInput implements AsyncIterableIterator<Uint8Array> {
  lines: AsyncLineIterator
  /**
   * The live pipe this reads while the substitution's command runs; when that
   * ends, its scope loads the rest for a descriptor the shell still holds
   * (`f() { exec 3<"$1"; }; f <(cmd)`) and clears the name.
   */
  pipe: PathSpec | null

  /** `source` is what the descriptor reads, or the line buffer of the
   * descriptor it duplicates, whose live pipe `pipe` names; one built over
   * a `PipeStream` takes that stream's. */
  constructor(
    source: ByteSource | AsyncLineIterator,
    pipe: PathSpec | null = null,
    readonly seekable = false,
  ) {
    this.lines = source instanceof AsyncLineIterator ? source : new AsyncLineIterator(source)
    this.pipe = source instanceof PipeStream || source instanceof PipeInput ? source.path : pipe
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  /** Another descriptor on the same open file, as `dup` makes: a read
   * through either moves the one offset. */
  dup(): SharedInput {
    return new SharedInput(this.lines, this.pipe, this.seekable)
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const chunk = await this.lines.readChunk()
    if (chunk === null) return { done: true, value: undefined }
    return { done: false, value: chunk }
  }

  /** Close the source for good, for a line that failed reading it. */
  discard(): Promise<void> {
    return this.lines.discard()
  }
}

/**
 * The one descriptor a construct hands every command it runs. `<
 * /dev/null` stays as it is: it reads nothing, so there is no position
 * to share, and its type tells a command no file is attached.
 */
export function share(stdin: ByteSource | null): ByteSource | null {
  if (stdin === null || stdin instanceof SharedInput || stdin instanceof DeviceInput) return stdin
  return new SharedInput(stdin)
}

/**
 * The line reader `read`, `mapfile` and `select` take input from: a
 * shared descriptor's own, so what they leave the next command reads,
 * else one over `stdin` alone.
 */
export function lineBuffer(stdin: ByteSource): AsyncLineIterator {
  return stdin instanceof SharedInput ? stdin.lines : new AsyncLineIterator(stdin)
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

/** Close unreferenced cursors once, preserving duplicate descriptors. */
export async function releaseInputs(
  inputs: SharedInput[],
  keep: SharedInput[] = [],
): Promise<void> {
  const retained = new Set(keep.map((source) => source.lines))
  for (const source of inputs) {
    if (!retained.has(source.lines)) {
      retained.add(source.lines)
      await source.discard()
    }
  }
}
