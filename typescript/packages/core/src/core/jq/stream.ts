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

import {
  CLOSE_BRACE,
  CLOSE_BRACKET,
  JqParser,
  MAX_PARSING_DEPTH,
  OPEN_BRACE,
  OPEN_BRACKET,
  QUOTE,
  decodeUtf8,
  stringText,
  utf8Missing,
} from './parse.ts'
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
 * The most bytes one read of jq's input reader takes (jq 1.8's util.c):
 * fgets into a 4096-byte buffer, less the four bytes it keeps for UTF-8 and
 * the NUL. A read stops after a newline, and one that ends inside a
 * character reads on to the end of it.
 */
export const READ_CHUNK = 4091

const NEWLINE = 0x0a
const SPACE = 0x20
const TAB = 0x09
const BACKSLASH = 0x5c
const WHITESPACE = new Set([SPACE, TAB, 0x0d, NEWLINE])
const CLOSERS = new Set([QUOTE, CLOSE_BRACKET, CLOSE_BRACE])
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// JSON.parse takes a lone surrogate escape, which jq refuses or replaces.
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/

/**
 * Whether a text nests deep enough that jq's parser could refuse it: its
 * stack holds each open array or object and the key each object waits on,
 * so half its limit in brackets alone is enough to leave it to jq.
 */
function nestsDeep(data: Uint8Array): boolean {
  const limit = MAX_PARSING_DEPTH / 2
  let openers = 0
  for (const byte of data) if (byte === OPEN_BRACKET || byte === OPEN_BRACE) openers += 1
  if (openers < limit) return false
  let depth = 0
  let inString = false
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]
    if (inString) {
      if (byte === BACKSLASH) i += 1
      else if (byte === QUOTE) inString = false
    } else if (byte === QUOTE) {
      inString = true
    } else if (byte === OPEN_BRACKET || byte === OPEN_BRACE) {
      depth += 1
      if (depth >= limit) return true
    } else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
      depth -= 1
    }
  }
  return false
}

/**
 * The text of one JSON value when JSON.parse reads it as one, which jq's
 * parser then reads as one value too, or null. JSON.parse also takes lone
 * surrogate escapes and nesting past jq's limit, which are left to jq's
 * parser along with everything JSON.parse refuses (jq's extra number forms,
 * invalid UTF-8). Only the extent is JSON.parse's to say; jq reads the text
 * itself.
 */
function parses(data: Uint8Array): string | null {
  let text: string
  try {
    text = STRICT.decode(data)
  } catch {
    return null
  }
  if (SURROGATE_ESCAPE.test(text) || nestsDeep(data)) return null
  try {
    JSON.parse(text)
  } catch {
    return null
  }
  return text
}

/**
 * Where jq's parser holds the one value `data` spells whole: at its closing
 * quote or bracket, or at the whitespace byte after a number or a literal.
 * -1 for a number or a literal nothing follows, which jq completes only at
 * the end of its input.
 */
function completion(data: Uint8Array): number {
  let stop = data.length
  while (stop > 0 && WHITESPACE.has(data[stop - 1] ?? 0)) stop -= 1
  if (CLOSERS.has(data[stop - 1] ?? 0)) return stop - 1
  return stop < data.length ? stop : -1
}

/**
 * The reads jq's reader takes from the start of `data`, one piece at a time,
 * until it holds byte `index`: where the last of them ends, and how many of
 * them end in a newline, which is what its line count counts. `data` holds
 * an input's unread bytes, from a piece boundary on, through at least the
 * piece holding `index`.
 */
export function piecesThrough(data: Uint8Array, index: number): [number, number] {
  // A piece never runs past a newline, so each newline before the line
  // holding `index` ended a piece of its own.
  let at = index > 0 ? data.lastIndexOf(NEWLINE, index - 1) + 1 : 0
  let lines = 0
  for (let i = 0; i < at; i++) if (data[i] === NEWLINE) lines += 1
  for (;;) {
    const window = data.subarray(at, at + READ_CHUNK)
    const newline = window.indexOf(NEWLINE)
    let end: number
    if (newline >= 0) {
      end = at + newline + 1
      lines += 1
    } else if (data.length - at > READ_CHUNK) {
      end = Math.min(at + READ_CHUNK + utf8Missing(window), data.length)
    } else {
      end = data.length
    }
    if (end > index) return [end, lines]
    at = end
  }
}

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
 * Each value comes out as JSON text for libjq to read (JqParser.text): the
 * bytes it was read from, so every number keeps its literal and every object
 * its key order, which jq prints as they came in. A value JSON.parse can
 * read, one line of JSON Lines or a pretty-printed document, is taken in one
 * step and handed to the parser as read (see fast); everything else, bad
 * input included, goes through jq's parser. `opts` decides the reading
 * through -R, -s, --seq and --stream.
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
  private readonly fastOk: boolean
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
  ) {
    this.sources = sources
    this.report = report
    this.parser = opts.rawInput ? null : new JqParser(opts.seq, opts.stream)
    this.fastOk = !(opts.rawInput || opts.seq || opts.stream)
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
   * Close the input the reader stopped in, as jq's exit closes its file: a
   * parse error, a halt, or a program that takes one `input` leaves it part
   * read, and an iterator nobody returns keeps its backend stream open.
   */
  async close(): Promise<void> {
    const chunks = this.chunks
    this.chunks = null
    await chunks?.return?.()
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
    let isLast = false
    for (;;) {
      if (parser.remaining() === 0) {
        if (this.fastOk && parser.clean()) {
          const fast = await this.fast(parser)
          if (fast !== NO_VALUE) {
            if (!Array.isArray(this.slurped)) return fast
            this.slurped.push(fast)
            continue
          }
        }
        const [piece, last] = await this.readMore()
        isLast = last
        parser.feed(piece, !isLast)
      }
      const value = parser.next()
      if (value instanceof JqParseError) return value
      if (Array.isArray(this.slurped)) {
        if (value !== NO_VALUE) this.slurped.push(parser.text())
      } else if (value !== NO_VALUE) {
        return parser.text()
      }
      if (isLast) break
    }
    return this.takeSlurped()
  }

  private async nextLine(): Promise<string | NoValue> {
    let line: string | NoValue = NO_VALUE
    for (;;) {
      const [piece, isLast] = await this.readMore()
      if (piece.length > 0) {
        if (typeof this.slurped === 'string') {
          this.slurped += decodeUtf8(piece)
        } else if (piece[piece.length - 1] === NEWLINE) {
          const head = line === NO_VALUE ? '' : line
          return stringText(head + decodeUtf8(piece.subarray(0, piece.length - 1)))
        } else {
          line = (line === NO_VALUE ? '' : line) + decodeUtf8(piece)
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

  /**
   * Take the next value's text in one step when JSON.parse reads it as one
   * value: the rest of the line, or else the pretty-printed document the
   * line opens (see document). The parser (clean, see JqParser.clean) is
   * handed the bytes as read and the rest of the last piece, so the line
   * count, the position and whatever follows are what jq's parser would have
   * reached.
   */
  private async fast(parser: JqParser): Promise<string | NoValue> {
    this.openNext()
    if (this.chunks === null) return NO_VALUE
    let newline = this.pending.indexOf(NEWLINE)
    while (newline < 0 && !this.drained) {
      const searched = this.pending.length
      await this.pull()
      newline = this.pending.indexOf(NEWLINE, searched)
    }
    const pending = this.pending
    if (pending.length === 0) return NO_VALUE
    const skip = parser.bomSkip(pending.view(0, Math.min(3, pending.length)))
    if (skip === null) return NO_VALUE
    if (newline < 0 && this.tailUnsettled()) return NO_VALUE
    const end = newline >= 0 ? newline + 1 : pending.length
    const line = pending.view(skip, end)
    const text = parses(line)
    if (text !== null) {
      const stop = completion(line)
      if (stop < 0) return NO_VALUE
      return this.took(parser, text, skip, skip + stop)
    }
    let last = line.length
    while (last > 0 && WHITESPACE.has(line[last - 1] ?? 0)) last -= 1
    if (last !== 1 || (line[0] !== OPEN_BRACKET && line[0] !== OPEN_BRACE)) return NO_VALUE
    return this.document(parser, skip, end)
  }

  /**
   * Take a pretty-printed document in one step: one whose opener stands
   * alone on the first line and whose closer starts a later line, every line
   * between them indented. `skip` counts the BOM bytes before the opener,
   * and `start` is where the opener's line ends.
   *
   * It reads on only to the first line that is not indented. The closer
   * there completes the document, and anything else hands it to jq's parser.
   * So it reads no further than jq's reader does before the document
   * completes, and never past one document of a stream.
   */
  private async document(parser: JqParser, skip: number, start: number): Promise<string | NoValue> {
    const pending = this.pending
    const closer = pending.byteAt(skip) === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET
    let at = start - 1
    let stop = -1
    while (stop < 0) {
      const newline = pending.indexOf(NEWLINE, at)
      const next = newline < 0 ? undefined : pending.byteAt(newline + 1)
      if (next === undefined) {
        if (this.drained) return NO_VALUE
        at = newline < 0 ? pending.length : newline
        await this.pull()
      } else if (next === SPACE || next === TAB) {
        at = newline + 1
      } else {
        stop = newline + 1
      }
    }
    if (pending.byteAt(stop) !== closer) return NO_VALUE
    let newline = pending.indexOf(NEWLINE, stop)
    while (newline < 0 && !this.drained) {
      const searched = pending.length
      await this.pull()
      newline = pending.indexOf(NEWLINE, searched)
    }
    if (newline < 0 && this.tailUnsettled()) return NO_VALUE
    const text = parses(pending.view(skip, stop + 1))
    if (text === null) return NO_VALUE
    return this.took(parser, text, skip, stop)
  }

  // Whether an input's bytes after its last newline cannot be taken as they
  // are: another input can run on from them, and a failed read loses them.
  private tailUnsettled(): boolean {
    return this.failed || this.opened < this.sources.length
  }

  // The value's text: what `stop` completes, whitespace around it left out.
  private took(parser: JqParser, text: string, skip: number, stop: number): string {
    const [end, lines] = piecesThrough(this.pending.view(), stop)
    parser.skip(this.pending.view(0, stop + 1), skip, stop + 1)
    this.pending.take(stop + 1)
    const rest = this.pending.take(end - stop - 1)
    this.line += lines
    parser.feed(rest, true)
    return trimmed(text)
  }
}

/** A text with the JSON whitespace around it left out. */
function trimmed(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && WHITESPACE.has(text.charCodeAt(start))) start += 1
  while (end > start && WHITESPACE.has(text.charCodeAt(end - 1))) end -= 1
  return start === 0 && end === text.length ? text : text.slice(start, end)
}

/**
 * The JSON text of every value of one input, and the parse error that ended
 * it early, as jq reads a --slurpfile.
 */
export async function readTexts(source: InputSource): Promise<[string[], JqParseError | null]> {
  const reader = new InputReader([source], jqOptions())
  const texts: string[] = []
  for (;;) {
    const text = await reader.nextInput()
    if (text instanceof JqParseError) return [texts, text]
    if (text === NO_VALUE) return [texts, null]
    texts.push(text)
  }
}

/**
 * The JSON text of the one value a text holds, as jq's jv_parse reads an
 * --argjson or a --jsonargs value, or NO_VALUE when it holds none, several,
 * or bad JSON.
 */
export function valueText(text: Uint8Array): string | NoValue {
  const fast = parses(text)
  if (fast !== null) return trimmed(fast)
  const parser = new JqParser()
  parser.feed(text, false)
  const value = parser.next()
  if (value === NO_VALUE || value instanceof JqParseError) return NO_VALUE
  const parsed = parser.text()
  return parser.next() === NO_VALUE ? parsed : NO_VALUE
}
