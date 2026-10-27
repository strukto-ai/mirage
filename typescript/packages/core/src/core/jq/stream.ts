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

// Follows jq 1.8.2's src/util.c (MIT; see licenses/third_party/jq.txt).

import { JqParser, decodeUtf8, stringText, utf8Missing } from './parse.ts'
import {
  JqParseError,
  NO_VALUE,
  UNKNOWN_POSITION,
  jqOptions,
  type InputSource,
  type JqOptions,
  type NoValue,
} from './types.ts'
import { READ_FAILURES } from '../../errors/constants.ts'
import { fsStrerror, isFsError } from '../../errors/fs.ts'

/**
 * The most bytes one read of jq's input reader takes (jq 1.8.2's util.c):
 * fgets into a 4096-byte buffer, less the four bytes it keeps for UTF-8 and
 * the NUL. A read stops after a newline, and one that ends inside a
 * character reads on to the end of it.
 */
export const READ_CHUNK = 4091

const NEWLINE = 0x0a
/** An input's bytes not yet read, a growable window over one buffer. */
class Pending {
  private buf = new Uint8Array(0)
  private start = 0
  private end = 0

  get length(): number {
    return this.end - this.start
  }

  view(from = 0, to = this.length): Uint8Array {
    return this.buf.subarray(this.start + from, this.start + to)
  }

  indexOf(byte: number, from = 0, to = this.length): number {
    const found = this.view(from, to).indexOf(byte)
    return found < 0 ? -1 : found + from
  }

  byteAt(index: number): number | undefined {
    return index < this.length ? this.buf[this.start + index] : undefined
  }

  push(chunk: Uint8Array): void {
    if (this.end + chunk.length > this.buf.length) {
      const live = this.length
      if (live + chunk.length <= this.buf.length) {
        this.buf.copyWithin(0, this.start, this.end)
      } else {
        const grown = new Uint8Array(Math.max(live + chunk.length, this.buf.length * 2, 4096))
        grown.set(this.view(), 0)
        this.buf = grown
      }
      this.start = 0
      this.end = live
    }
    this.buf.set(chunk, this.end)
    this.end += chunk.length
  }

  take(count: number): Uint8Array {
    const out = this.buf.slice(this.start, this.start + count)
    this.start += count
    return out
  }
}

/**
 * jq's input reader (util.c) over every input of an invocation.
 *
 * One parser reads all of them, one after another, so a value can run on
 * from one input into the next the way it does in jq (`1` then `2` read as
 * `12`), and a parse error counts its lines across the inputs. The parser is
 * fed the pieces jq's fgets reads, so the position a run reports, the input's
 * name and the lines read of it, is jq's. Under -R the pieces make up the
 * lines, which also run on from one input into the next when one lacks its
 * final newline.
 *
 * Each value comes out as original JSON text or literal-preserving
 * streaming event text from the shared scanner.
 *
 * An input is opened when the reader reaches it, and one that cannot be
 * opened or read is reported and counted the way jq's reader does it, and
 * the reader moves on to the next (see fail). `report` takes each line jq's
 * reader writes to stderr about such an input; without it, the error
 * propagates instead.
 */
export class InputReader {
  private readonly sources: readonly InputSource[]
  private readonly report: ((line: string) => void) | null
  private failedInputs = 0
  private opened = 0
  private readonly parser: JqParser | null
  private jsonEof = false
  private slurped: string[] | string | NoValue = NO_VALUE
  private name: string | null = null
  private line = 0
  private chunks: AsyncIterator<Uint8Array> | null = null
  private pending = new Pending()
  private drained = false
  private feof = false
  private fresh = true
  private failed = false

  constructor(
    sources: readonly InputSource[],
    opts: JqOptions,
    report: ((line: string) => void) | null = null,
    private readonly signal?: AbortSignal,
  ) {
    this.sources = sources
    this.report = report
    this.parser = opts.rawInput ? null : new JqParser(opts.seq, opts.stream, signal)
    if (opts.slurp) this.slurped = opts.rawInput ? '' : []
  }

  /**
   * How many inputs could not be opened or read, which jq's main loop checks
   * before it reads each document (jq_util_input_errors).
   */
  failures(): number {
    return this.failedInputs
  }

  /**
   * Where jq's reader stands, as its error reports word it: the current
   * input and the lines read of it, or `<unknown>` before any input was
   * opened.
   */
  position(): string {
    if (this.name === null) return UNKNOWN_POSITION
    return `${this.name}:${String(this.line)}`
  }

  /**
   * The input the reader reads, null before it opened one, which
   * `input_filename` answers (jq_util_input_get_current_filename).
   */
  filename(): string | null {
    return this.name
  }

  /**
   * The lines read of the current input, which `input_line_number` answers
   * (jq_util_input_get_current_line).
   */
  lineNumber(): number {
    return this.line
  }

  /**
   * Close the input the reader stopped in, as jq's exit closes its file: a
   * parse error, a halt, or a program that takes one `input` leaves it part
   * read, and an iterator nobody returns keeps its backend stream open.
   */
  async close(): Promise<void> {
    const chunks = this.chunks
    this.chunks = null
    try {
      await chunks?.return?.()
    } finally {
      await this.parser?.close()
    }
  }

  /**
   * The JSON text of the next value of the stream, the parse error that stops
   * it, or NO_VALUE once it is used up (jq_util_input_next_input). Under -s
   * the one value is the whole stream; a parse error comes back instead of
   * it.
   */
  async nextInput(): Promise<string | JqParseError | NoValue> {
    const parser = this.parser
    if (parser === null) return this.nextLine()
    for (;;) {
      const value = await parser.next()
      if (value instanceof JqParseError) return value
      if (value !== NO_VALUE) {
        if (!Array.isArray(this.slurped)) return value
        this.slurped.push(value)
        continue
      }
      if (this.jsonEof) break
      const [piece, last] = await this.readMore()
      this.jsonEof = last
      parser.feed(piece, !last)
    }
    return this.takeSlurped()
  }

  private async nextLine(): Promise<string | NoValue> {
    let line: string | NoValue = NO_VALUE
    for (;;) {
      const [piece, isLast] = await this.readMore()
      if (piece.length > 0) {
        if (typeof this.slurped === 'string') {
          this.slurped += await decodeUtf8(piece, this.signal)
        } else if (piece[piece.length - 1] === NEWLINE) {
          const head = line === NO_VALUE ? '' : line
          return stringText(
            head + (await decodeUtf8(piece.subarray(0, piece.length - 1), this.signal)),
          )
        } else {
          line = (line === NO_VALUE ? '' : line) + (await decodeUtf8(piece, this.signal))
        }
      }
      if (isLast) break
    }
    if (typeof this.slurped === 'string') return this.takeSlurped()
    return line === NO_VALUE ? line : stringText(line)
  }

  private takeSlurped(): string | NoValue {
    const slurped = this.slurped
    this.slurped = NO_VALUE
    if (Array.isArray(slurped)) return `[${slurped.join(',')}]`
    return slurped === NO_VALUE ? slurped : stringText(slurped)
  }

  /**
   * Move on to the next input once the current one is read to its end, the
   * first half of jq's read_more.
   */
  private openNext(): void {
    if (this.chunks !== null && !this.feof) return
    this.chunks = null
    const source = this.sources[this.opened]
    if (source === undefined) return
    this.opened += 1
    this.name = source.name
    this.line = 0
    this.chunks = source.chunks[Symbol.asyncIterator]()
    this.pending = new Pending()
    this.drained = false
    this.feof = false
    this.fresh = true
    this.failed = false
  }

  private async pull(): Promise<void> {
    if (this.chunks === null) return
    let next: IteratorResult<Uint8Array>
    try {
      next = await this.chunks.next()
    } catch (error) {
      if (this.report === null || !isFsError(error)) throw error
      this.fail(error, this.report)
      return
    }
    if (next.done === true) {
      this.drained = true
    } else {
      this.pending.push(next.value)
      if (next.value.length > 0) this.fresh = false
    }
  }

  /**
   * Count an input that could not be opened or read, and report it in the
   * words of jq's reader: fopen's failure names the input, a failed read is
   * the bare strerror. A directory opens, and fails at its first read. The
   * input ends there, and the line fgets was reading when it failed is lost
   * with it.
   */
  private fail(error: unknown, report: (line: string) => void): void {
    const strerror = fsStrerror(error) ?? ''
    const code = (error as { code?: string }).code
    if (this.fresh && (code === undefined || !READ_FAILURES.has(code))) {
      report(`jq: error: Could not open file ${this.name ?? ''}: ${strerror}\n`)
    } else {
      report(`jq: error: ${strerror}\n`)
    }
    this.failedInputs += 1
    this.failed = true
    this.drained = true
  }

  /**
   * jq's read_more: the next piece of the input, and whether the stream is
   * used up, which a piece comes back empty for.
   */
  private async readMore(): Promise<[Uint8Array, boolean]> {
    this.openNext()
    const piece = this.chunks === null ? new Uint8Array(0) : await this.readPiece()
    return [piece, this.opened === this.sources.length && this.chunks === null]
  }

  private async readPiece(): Promise<Uint8Array> {
    const pending = this.pending
    for (;;) {
      const newline = pending.indexOf(NEWLINE, 0, Math.min(READ_CHUNK, pending.length))
      if (newline >= 0) {
        this.line += 1
        return pending.take(newline + 1)
      }
      if (pending.length >= READ_CHUNK) {
        const head = pending.take(READ_CHUNK)
        const missing = utf8Missing(head)
        while (missing > 0 && pending.length < missing && !this.drained) await this.pull()
        if (missing === 0) return head
        const tail = pending.take(Math.min(missing, pending.length))
        const piece = new Uint8Array(head.length + tail.length)
        piece.set(head, 0)
        piece.set(tail, head.length)
        return piece
      }
      if (this.drained) {
        this.feof = true
        const rest = pending.take(pending.length)
        return this.failed ? new Uint8Array(0) : rest
      }
      await this.pull()
    }
  }
}

/**
 * The JSON text of every value of one input, and the parse error that ended
 * it early, as jq reads a --slurpfile.
 */
export async function readTexts(source: InputSource): Promise<[string[], JqParseError | null]> {
  const reader = new InputReader([source], jqOptions())
  const texts: string[] = []
  try {
    for (;;) {
      const text = await reader.nextInput()
      if (text instanceof JqParseError) return [texts, text]
      if (text === NO_VALUE) return [texts, null]
      texts.push(text)
    }
  } finally {
    await reader.close()
  }
}

/**
 * The JSON text of the one value a text holds, as jq's jv_parse reads an
 * --argjson or a --jsonargs value, or NO_VALUE when it holds none, several,
 * or bad JSON.
 */
export async function valueText(text: Uint8Array): Promise<string | NoValue> {
  const parser = new JqParser()
  try {
    parser.feed(text, false)
    const value = await parser.next()
    if (value === NO_VALUE || value instanceof JqParseError) return NO_VALUE
    return (await parser.next()) === NO_VALUE ? value.trim() : NO_VALUE
  } finally {
    await parser.close()
  }
}
