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

// Follows jq 1.8.2's src/jv_parse.c, with the UTF-8 decoding of its
// src/jv.c, src/jv_unicode.c and src/jv_utf8_tables.h (MIT; see
// licenses/third_party/jq.txt).

import { JqParseError, NO_VALUE, NumberText, type NoValue } from './types.ts'

// The deepest jq nests arrays, objects and the keys between them. jq's
// streaming parser has no limit, but every event it hands out copies its
// path, so input nested n deep costs time in n squared: mirage holds it
// to this depth as well.
export const MAX_PARSING_DEPTH = 10000
const DEPTH_EXCEEDED = 'Exceeds depth limit for parsing'

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf)
const BOM_DONE = UTF8_BOM.length
// Where the BOM check stands once a BOM prefix met the wrong byte.
const BOM_MALFORMED = 0xff

const RS = 0x1e
const NEWLINE = 0x0a
export const QUOTE = 0x22
const BACKSLASH = 0x5c
const APOSTROPHE = 0x27
const LOWER_F = 0x66
const LOWER_N = 0x6e
const LOWER_T = 0x74
const LOWER_U = 0x75
export const OPEN_BRACKET = 0x5b
export const CLOSE_BRACKET = 0x5d
export const OPEN_BRACE = 0x7b
export const CLOSE_BRACE = 0x7d
const COLON = 0x3a
const COMMA = 0x2c
// The first byte past the control characters, which a string may hold
// only escaped.
const SPACE = 0x20

/** A table over every byte value: 1 for each byte `member` accepts. */
function byteTable(member: (byte: number) => boolean): Uint8Array {
  const table = new Uint8Array(256)
  for (let byte = 0; byte < 256; byte += 1) table[byte] = member(byte) ? 1 : 0
  return table
}

function ord(ch: string): number {
  return ch.charCodeAt(0)
}

const WHITESPACE = byteTable((byte) => ' \t\r\n'.includes(String.fromCharCode(byte)))
const STRUCTURE = byteTable((byte) => '[,]{:}'.includes(String.fromCharCode(byte)))
// What stands between two values of a stream: whitespace, and under --seq
// the RS before each one.
const SEPARATORS = byteTable((byte) => WHITESPACE[byte] === 1 || byte === RS)

// Runs of bytes that each go through jq's scan() the same way, so a run
// is taken in one step: a literal's bytes, whitespace, a string's body.
const LITERAL_RUN = byteTable(
  (byte) => WHITESPACE[byte] === 0 && STRUCTURE[byte] === 0 && byte !== QUOTE,
)
const LITERAL_RUN_SEQ = byteTable((byte) => LITERAL_RUN[byte] === 1 && byte !== RS)
const STRING_RUN = byteTable((byte) => byte !== QUOTE && byte !== BACKSLASH)
const STRING_RUN_SEQ = byteTable((byte) => STRING_RUN[byte] === 1 && byte !== RS)

// What decNumber reads as a number: jq accepts a sign, a bare dot, leading
// zeros, Infinity and NaN, where JSON does not.
const DECIMAL = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/
const INTEGER = /^[+-]?[0-9]+$/
const INFINITY = /^[+-]?(?:inf|infinity)$/i
const NAN = /^[+-]?s?nan0*$/i

const ESCAPES: ReadonlyMap<number, number> = new Map([
  [ord('\\'), ord('\\')],
  [ord('"'), ord('"')],
  [ord('/'), ord('/')],
  [ord('b'), ord('\b')],
  [ord('f'), ord('\f')],
  [ord('t'), ord('\t')],
  [ord('n'), ord('\n')],
  [ord('r'), ord('\r')],
])

// jq's UTF-8 tables (jv_utf8_tables.h): how long a sequence each lead
// byte starts (0 for a byte no sequence starts with, CONTINUATION for a
// continuation byte), and the first code point each length may encode.
const CONTINUATION = 0xff
const CODING_LENGTH = Uint8Array.from([
  ...new Array<number>(0x80).fill(1),
  ...new Array<number>(0x40).fill(CONTINUATION),
  ...new Array<number>(2).fill(0),
  ...new Array<number>(30).fill(2),
  ...new Array<number>(16).fill(3),
  ...new Array<number>(5).fill(4),
  ...new Array<number>(11).fill(0),
])
const FIRST_CODE_POINT: readonly number[] = [0, 0, 0x80, 0x800, 0x10000]
const REPLACEMENT = String.fromCharCode(0xfffd)

const EXPECTED_SEPARATOR = 'Expected separator between values'
const SURROGATE_PAIR = 'Invalid \\uXXXX\\uXXXX surrogate pair escape'
const CONTROL_CHARACTER =
  'Invalid string: control characters from U+0000 through U+001F must be escaped'

const DEC_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Where jq's scanner stands: between tokens, inside a string, just after a
 * backslash in one, or skipping to the next RS under --seq.
 */
const ParseState = Object.freeze({
  NORMAL: 'normal',
  STRING: 'string',
  STRING_ESCAPE: 'string-escape',
  WAITING_FOR_RS: 'waiting-for-rs',
} as const)

type ParseState = (typeof ParseState)[keyof typeof ParseState]

/**
 * The last thing jq's streaming parser read, which decides what may come
 * next.
 */
const LastSeen = Object.freeze({
  NONE: 'none',
  OPEN_ARRAY: 'open-array',
  OPEN_OBJECT: 'open-object',
  COLON: 'colon',
  COMMA: 'comma',
  VALUE: 'value',
} as const)

type LastSeen = (typeof LastSeen)[keyof typeof LastSeen]

/**
 * scan() producing an output, which jq signals with a message of its own
 * rather than an error.
 */
const OUTPUT: unique symbol = Symbol('output')
type Scanned = typeof OUTPUT

/**
 * What jq's parser stacks: an open array, an open object, or the key the
 * object below it takes its next value under.
 */
type Frame = unknown[] | Record<string, unknown> | string

/**
 * One step of a streaming path: an array index, an object key, or null for
 * the key of an object not read yet.
 */
type PathItem = number | string | null

/**
 * Decode bytes the way jq builds a string from them: a sequence that is not
 * valid UTF-8 (a stray byte, an overlong form, an encoded surrogate, one
 * past U+10FFFF, or one cut short) turns into a single U+FFFD (jv.c's
 * jvp_string_copy_replace_bad over jvp_utf8_next). A sequence the end of
 * the bytes cuts short takes every byte left with it.
 */
export function decodeUtf8(data: Uint8Array): string {
  try {
    return DEC_FATAL.decode(data)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
  }
  const out: string[] = []
  let valid = 0
  let i = 0
  const end = data.length
  while (i < end) {
    const first = data[i] ?? 0
    if (first < 0x80) {
      i += 1
      continue
    }
    const length = CODING_LENGTH[first] ?? 0
    if (length === 0 || length === CONTINUATION) {
      out.push(DEC_FATAL.decode(data.subarray(valid, i)), REPLACEMENT)
      i += 1
      valid = i
      continue
    }
    if (length > end - i) {
      out.push(DEC_FATAL.decode(data.subarray(valid, i)), REPLACEMENT)
      valid = end
      break
    }
    let point = first & (0xff >> (length + 1))
    let taken = length
    for (let k = 1; k < length; k += 1) {
      const byte = data[i + k] ?? 0
      if (CODING_LENGTH[byte] !== CONTINUATION) {
        point = -1
        taken = k
        break
      }
      point = (point << 6) | (byte & 0x3f)
    }
    if (
      point < (FIRST_CODE_POINT[length] ?? 0) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point > 0x10ffff
    ) {
      out.push(DEC_FATAL.decode(data.subarray(valid, i)), REPLACEMENT)
      valid = i + taken
    }
    i += taken
  }
  out.push(DEC_FATAL.decode(data.subarray(valid, end)))
  return out.join('')
}

/**
 * How many bytes would finish the UTF-8 character a piece ends in
 * (jv_unicode.c's jvp_utf8_backtrack): 0 when it ends whole, or on a byte no
 * sequence explains. `piece` is the bytes read so far, at least one.
 */
export function utf8Missing(piece: Uint8Array): number {
  let i = piece.length - 1
  if (i === 0) return 0
  let seen = 1
  while (CODING_LENGTH[piece[i] ?? 0] === CONTINUATION) {
    if (i === 0) break
    i -= 1
    seen += 1
  }
  const length = CODING_LENGTH[piece[i] ?? 0] ?? 0
  if (length === 0 || length === CONTINUATION || length < seen) return 0
  return length - seen
}

/**
 * The number a literal token spells, as decNumber reads it, or NO_VALUE when
 * it spells none. jq takes NaN only with no payload digits other than zeros.
 *
 * `literal` is the token up to its first NUL, one character per byte
 * (latin1), so a byte past ASCII never matches.
 */
export function numberValue(literal: string): number | NoValue {
  if (INTEGER.test(literal)) return Number(literal)
  if (DECIMAL.test(literal)) return Number(literal)
  if (INFINITY.test(literal)) return literal.startsWith('-') ? -Infinity : Infinity
  if (NAN.test(literal)) return NaN
  return NO_VALUE
}

function hexDigit(byte: number | undefined): number {
  if (byte === undefined) return -1
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10
  return -1
}

function unhex4(data: Uint8Array, at: number): number {
  let point = 0
  for (let k = at; k < at + 4; k += 1) {
    const digit = hexDigit(data[k])
    if (digit < 0) return -1
    point = (point << 4) | digit
  }
  return point
}

/** A string as JSON text, which jq's parser reads back as that string. */
export function stringText(value: string): string {
  return JSON.stringify(value)
}

/**
 * A --stream event as JSON text: its path, then its leaf, a number spelled
 * as its literal (see NumberText). `event` is `[path]` or `[path, leaf]`, as
 * the streaming parser hands it out.
 */
export function eventText(event: unknown): string {
  const [path, ...rest] = event as [unknown, ...unknown[]]
  const head = JSON.stringify(path)
  if (rest.length === 0) return `[${head}]`
  const leaf = rest[0]
  return `[${head},${leaf instanceof NumberText ? leaf.text : JSON.stringify(leaf)}]`
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

/** Whether a parsed value is a number: a --stream leaf keeps its literal. */
function isNumeric(value: unknown): boolean {
  return typeof value === 'number' || value instanceof NumberText
}

/** The bytes after any separators they start with. */
function afterSeparators(bytes: Uint8Array): Uint8Array {
  let at = 0
  while (at < bytes.length && SEPARATORS[bytes[at] ?? 0] === 1) at += 1
  return bytes.subarray(at)
}

function isObject(frame: unknown): frame is Record<string, unknown> {
  return typeof frame === 'object' && frame !== null && !Array.isArray(frame)
}

/**
 * Set one key of a parsed object. `__proto__` becomes an own key, as
 * JSON.parse makes it, rather than the object's prototype.
 */
function setKey(owner: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(owner, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  } else {
    owner[key] = value
  }
}

/** The bytes as text, one character per byte. */
function latin1(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 8192) {
    text += String.fromCharCode(...bytes.subarray(at, at + 8192))
  }
  return text
}

/** Whether the bytes are exactly `word`, an ASCII literal. */
function spells(bytes: Uint8Array, word: string): boolean {
  if (bytes.length !== word.length) return false
  for (let i = 0; i < word.length; i += 1) if (bytes[i] !== word.charCodeAt(i)) return false
  return true
}

/**
 * Write one code point as UTF-8 (jvp_utf8_encode), a surrogate as the three
 * bytes that encode it, and say how many bytes it took.
 */
function encodeUtf8(point: number, out: Uint8Array, at: number): number {
  if (point <= 0x7f) {
    out[at] = point
    return 1
  }
  if (point <= 0x7ff) {
    out[at] = 0xc0 | (point >> 6)
    out[at + 1] = 0x80 | (point & 0x3f)
    return 2
  }
  if (point <= 0xffff) {
    out[at] = 0xe0 | (point >> 12)
    out[at + 1] = 0x80 | ((point >> 6) & 0x3f)
    out[at + 2] = 0x80 | (point & 0x3f)
    return 3
  }
  out[at] = 0xf0 | (point >> 18)
  out[at + 1] = 0x80 | ((point >> 12) & 0x3f)
  out[at + 2] = 0x80 | ((point >> 6) & 0x3f)
  out[at + 3] = 0x80 | (point & 0x3f)
  return 4
}

/** Where the run of `table` bytes that begins at `start` ends. */
function runEnd(table: Uint8Array, data: Uint8Array, start: number): number {
  let stop = start + 1
  while (stop < data.length && table[data[stop] ?? 0] === 1) stop += 1
  return stop
}

/** The bytes of the token being read (jq's tokenbuf), grown as it fills. */
class TokenBuffer {
  private data = new Uint8Array(256)
  length = 0

  push(byte: number): void {
    if (this.length === this.data.length) this.grow(this.length + 1)
    this.data[this.length] = byte
    this.length += 1
  }

  pushRun(source: Uint8Array, start: number, stop: number): void {
    const need = this.length + stop - start
    if (need > this.data.length) this.grow(need)
    this.data.set(source.subarray(start, stop), this.length)
    this.length = need
  }

  clear(): void {
    this.length = 0
  }

  /** The token's bytes, a view that the next write may change. */
  view(): Uint8Array {
    return this.data.subarray(0, this.length)
  }

  private grow(need: number): void {
    let size = this.data.length * 2
    while (size < need) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.data.subarray(0, this.length))
    this.data = grown
  }
}

/**
 * jq 1.8.2's JSON parser, byte for byte.
 *
 * This follows jq's src/jv_parse.c (MIT; see licenses/third_party/jq.txt):
 * the same states, checks and messages, and the same line and column
 * counters, which count bytes. It takes what jq takes (NaN, Infinity, a
 * leading `+`, `.5`, `01`) and refuses where jq refuses: `1true` is one bad
 * numeric literal, `truefalse` one bad literal, and a string is checked only
 * at its closing quote. A value completes where jq's does, a string or a
 * container at its closer and a number or a literal at the byte after it,
 * so `1]` fails before printing 1 while `1 ]` prints it first.
 *
 * Feed it one buffer at a time (jv_parser_set_buf) and pull what it parsed
 * (jv_parser_next); the reader over it decides the buffers. What it parsed is
 * also there as text (see text()), which is what libjq is handed: jq keeps a
 * number's literal and an object's key order, and the text keeps both where
 * the value cannot.
 *
 * `seq` is --seq, an RFC 7464 text sequence: nothing counts before the first
 * RS, and a bad value is reported and skipped. `streaming` is --stream,
 * which hands out `[path, leaf]` events as the input goes by instead of
 * whole values. Mirrors Python's JqParser.
 */
export class JqParser {
  private readonly literalRun: Uint8Array
  private readonly stringRun: Uint8Array
  private stack: Frame[] = []
  private path: PathItem[] = []
  private lastSeen: LastSeen = LastSeen.NONE
  private output: unknown[] | NoValue = NO_VALUE
  private nextValue: unknown = NO_VALUE
  private produced: unknown = NO_VALUE
  private readonly token = new TokenBuffer()
  private line = 1
  private column = 0
  private state: ParseState
  private lastChWasWs = false
  private eof = false
  private bom = 0
  private buf: Uint8Array | null = null
  private pos = 0
  private partial = false
  // Where the bytes of the next value begin in the buffer, the bytes of it
  // earlier buffers held, whether the value last completed ended before the
  // byte that completed it (a literal does), and the last value's bytes, or
  // under --stream the last event.
  private mark = 0
  private carry: Uint8Array[] = []
  private before = false
  private textBytes: Uint8Array = new Uint8Array(0)
  private last: unknown = NO_VALUE

  constructor(
    private readonly seq = false,
    private readonly streaming = false,
  ) {
    this.literalRun = seq ? LITERAL_RUN_SEQ : LITERAL_RUN
    this.stringRun = seq ? STRING_RUN_SEQ : STRING_RUN
    this.state = seq ? ParseState.WAITING_FOR_RS : ParseState.NORMAL
  }

  /**
   * Hand the parser its next buffer (jv_parser_set_buf), once the one before
   * it is used up; `partial` says whether more input follows it. A UTF-8 BOM
   * is stripped from the start of the whole input; a BOM cut short is
   * reported by next().
   */
  feed(data: Uint8Array, partial: boolean): void {
    let start = 0
    while (start < data.length && this.bom < BOM_DONE) {
      if (data[start] === UTF8_BOM[this.bom]) {
        start += 1
        this.bom += 1
      } else if (this.bom === 0) {
        this.bom = BOM_DONE
      } else {
        this.bom = BOM_MALFORMED
      }
    }
    this.buf = data
    this.pos = start
    this.partial = partial
    this.mark = start
  }

  /**
   * The JSON text of the value next() handed back last, which jq's parser
   * reads as that value: the bytes it was read from, or under --stream the
   * event with a number leaf spelled as its literal.
   */
  text(): string {
    if (this.streaming) return eventText(this.last)
    return decodeUtf8(this.textBytes)
  }

  /** Bytes of the current buffer not yet parsed. */
  remaining(): number {
    return this.buf === null ? 0 : this.buf.length - this.pos
  }

  /**
   * Whether the parser stands between two whole values with nothing
   * pending, which is where a value can be taken from the input in one step
   * and handed over as if the parser had read it. A BOM read only in part is
   * pending too: the check goes on into the next input.
   */
  clean(): boolean {
    return (
      !this.seq &&
      !this.streaming &&
      !this.eof &&
      this.state === ParseState.NORMAL &&
      this.stack.length === 0 &&
      this.token.length === 0 &&
      this.nextValue === NO_VALUE &&
      this.remaining() === 0 &&
      (this.bom === 0 || this.bom === BOM_DONE)
    )
  }

  /**
   * How many leading bytes the BOM check would strip from the start of the
   * input (`data`, its first bytes), for a caller that parses the start
   * itself; null when they begin a BOM they do not finish, which is the
   * parser's to report.
   */
  bomSkip(data: Uint8Array): number | null {
    if (this.bom >= BOM_DONE) return 0
    if (
      data.length >= BOM_DONE &&
      data[0] === UTF8_BOM[0] &&
      data[1] === UTF8_BOM[1] &&
      data[2] === UTF8_BOM[2]
    ) {
      return BOM_DONE
    }
    return data[0] !== UTF8_BOM[0] ? 0 : null
  }

  /**
   * Count bytes a caller parsed itself (see clean()) as read: the BOM check
   * is settled, the line and column move on, and the last byte decides
   * whether the parser last saw whitespace. `data` holds the bytes, a BOM
   * before `start` included; `start` is the first index taken past the BOM
   * and `stop` is just past the last.
   */
  skip(data: Uint8Array, start: number, stop: number): void {
    this.bom = BOM_DONE
    if (stop > start) {
      this.advance(data, start, stop)
      this.lastChWasWs = WHITESPACE[data[stop - 1] ?? 0] === 1
    }
  }

  /**
   * The next value, the JqParseError that stops it, or NO_VALUE when the
   * buffer ran out first or the input ended with nothing left
   * (jv_parser_next).
   */
  next(): unknown {
    const buf = this.buf
    if (this.eof || buf === null) return NO_VALUE
    if (this.bom === BOM_MALFORMED) {
      if (!this.seq) return new JqParseError('Malformed BOM')
      this.state = ParseState.WAITING_FOR_RS
      this.reset()
    }
    if (this.streaming) {
      const done = this.streamCheckDone()
      if (done !== NO_VALUE) {
        this.last = done
        return done
      }
    }
    this.produced = NO_VALUE
    const end = buf.length
    let pos = this.pos
    let msg: string | Scanned | null = null
    let ch = -1
    while (msg === null && pos < end) {
      const state = this.state
      if (state === ParseState.WAITING_FOR_RS) {
        const rs = buf.indexOf(RS, pos)
        const stop = rs < 0 ? end : rs + 1
        this.advance(buf, pos, stop)
        pos = stop
        this.mark = pos
        if (rs >= 0) this.state = ParseState.NORMAL
        continue
      }
      ch = buf[pos] ?? 0
      if (state === ParseState.NORMAL) {
        if (this.literalRun[ch] === 1) {
          const stop = runEnd(this.literalRun, buf, pos)
          this.token.pushRun(buf, pos, stop)
          this.column += stop - pos
          this.lastChWasWs = false
          pos = stop
          continue
        }
        if (WHITESPACE[ch] === 1 && this.token.length === 0) {
          const stop = runEnd(WHITESPACE, buf, pos)
          this.advance(buf, pos, stop)
          this.lastChWasWs = true
          pos = stop
          continue
        }
      } else if (state === ParseState.STRING && this.stringRun[ch] === 1) {
        const stop = runEnd(this.stringRun, buf, pos)
        this.token.pushRun(buf, pos, stop)
        this.advance(buf, pos, stop)
        this.lastChWasWs = false
        pos = stop
        continue
      }
      pos += 1
      msg = this.scan(ch)
    }
    this.pos = pos
    if (msg === OUTPUT) {
      const produced = this.produced
      if (produced === NO_VALUE) {
        // An RS dropped what it cut short.
        this.mark = pos
      } else {
        this.take(buf, this.before ? pos - 1 : pos)
        this.last = produced
      }
      return produced
    }
    if (msg !== null) {
      this.mark = pos
      const where = `at line ${String(this.line)}, column ${String(this.column)}`
      if (ch !== RS && this.seq) {
        this.state = ParseState.WAITING_FOR_RS
        const failure = new JqParseError(`${msg} ${where} (need RS to resync)`)
        this.reset()
        return failure
      }
      const failure = new JqParseError(`${msg} ${where}`)
      this.reset()
      if (!this.seq) {
        this.buf = null
        this.pos = 0
      }
      return failure
    }
    if (this.partial) {
      this.hold(buf, end)
      return NO_VALUE
    }
    const value = this.atEof()
    if (value !== NO_VALUE && !(value instanceof JqParseError)) {
      this.take(buf, end)
      this.last = value
    }
    return value
  }

  // The bytes of the value just completed, which end at `stop`: the next
  // value's begin after them.
  private take(buf: Uint8Array, stop: number): void {
    if (this.streaming) return
    const tail = buf.subarray(this.mark, stop)
    if (this.carry.length === 0) {
      this.textBytes = afterSeparators(tail).slice()
    } else {
      this.carry.push(tail)
      let size = 0
      for (const part of this.carry) size += part.length
      const whole = new Uint8Array(size)
      let at = 0
      for (const part of this.carry) {
        whole.set(part, at)
        at += part.length
      }
      this.textBytes = afterSeparators(whole)
      this.carry = []
    }
    this.mark = stop
  }

  // Keep the bytes of a value the buffer ended inside of.
  private hold(buf: Uint8Array, stop: number): void {
    if (this.streaming) return
    const held = buf.subarray(this.mark, stop)
    const kept = this.carry.length === 0 ? afterSeparators(held) : held
    if (kept.length > 0) this.carry.push(kept.slice())
    this.mark = stop
  }

  private atEof(): unknown {
    this.eof = true
    const where = `at EOF at line ${String(this.line)}, column ${String(this.column)}`
    if (this.state === ParseState.WAITING_FOR_RS) {
      return new JqParseError(`Unfinished abandoned text ${where}`)
    }
    if (this.state !== ParseState.NORMAL) return this.failAtEof(`Unfinished string ${where}`)
    const msg = this.checkLiteral()
    if (msg !== null) return this.failAtEof(`${msg} ${where}`)
    if (this.streaming ? this.path.length > 0 : this.stack.length > 0) {
      return this.failAtEof(`Unfinished JSON term ${where}`)
    }
    let value = this.nextValue
    if (this.streaming && value !== NO_VALUE) value = [[...this.path], value]
    this.nextValue = NO_VALUE
    if (this.seq && !this.lastChWasWs && isNumeric(value)) {
      return new JqParseError(`Potentially truncated top-level numeric value ${where}`)
    }
    return value
  }

  private failAtEof(message: string): JqParseError {
    this.reset()
    this.state = ParseState.WAITING_FOR_RS
    return new JqParseError(message)
  }

  private advance(data: Uint8Array, start: number, stop: number): void {
    let newlines = 0
    let last = -1
    for (let i = start; i < stop; i += 1) {
      if (data[i] === NEWLINE) {
        newlines += 1
        last = i
      }
    }
    if (newlines > 0) {
      this.line += newlines
      this.column = stop - (last + 1)
    } else {
      this.column += stop - start
    }
  }

  private reset(): void {
    if (this.streaming) this.path = []
    this.lastSeen = LastSeen.NONE
    this.output = NO_VALUE
    this.nextValue = NO_VALUE
    this.stack = []
    this.token.clear()
    this.carry = []
    this.state = ParseState.NORMAL
  }

  private value(value: unknown): string | null {
    if (this.streaming) {
      if (this.nextValue !== NO_VALUE || this.lastSeen === LastSeen.VALUE) {
        return EXPECTED_SEPARATOR
      }
      this.lastSeen = this.path.length > 0 ? LastSeen.VALUE : LastSeen.NONE
    } else if (this.nextValue !== NO_VALUE) {
      return EXPECTED_SEPARATOR
    }
    this.nextValue = value
    return null
  }

  private checkDone(): unknown {
    if (this.streaming) return this.streamCheckDone()
    if (this.stack.length === 0 && this.nextValue !== NO_VALUE) {
      const done = this.nextValue
      this.nextValue = NO_VALUE
      return done
    }
    return NO_VALUE
  }

  private streamCheckDone(): unknown {
    if (this.path.length === 0 && this.nextValue !== NO_VALUE) {
      const done = [[], this.nextValue]
      this.nextValue = NO_VALUE
      return done
    }
    const output = this.output
    if (output === NO_VALUE) return NO_VALUE
    if (output.length > 2) {
      this.output = output.slice(0, 1)
      return output.slice(0, 2)
    }
    this.output = NO_VALUE
    return output
  }

  private checkTruncation(): boolean {
    if (this.streaming) {
      const next = this.nextValue
      return (
        this.path.length > 0 ||
        (next !== NO_VALUE && (next === null || isNumeric(next) || typeof next === 'boolean'))
      )
    }
    return (
      !this.lastChWasWs &&
      (this.stack.length > 0 || this.token.length > 0 || isNumeric(this.nextValue))
    )
  }

  private isTopNum(): boolean {
    const above = this.streaming ? this.path : this.stack
    return above.length === 0 && isNumeric(this.nextValue)
  }

  private scan(ch: number): string | Scanned | null {
    this.column += 1
    if (ch === NEWLINE) {
      this.line += 1
      this.column = 0
    }
    if (this.seq && ch === RS) {
      if (this.checkTruncation()) {
        if (this.checkLiteral() === null && this.isTopNum()) {
          return 'Potentially truncated top-level numeric value'
        }
        return 'Truncated value'
      }
      const msg = this.checkLiteral()
      if (msg !== null) return msg
      if (this.state === ParseState.NORMAL) {
        const done = this.checkDone()
        if (done !== NO_VALUE) {
          this.produced = done
          this.before = true
          return OUTPUT
        }
      }
      this.reset()
      this.produced = NO_VALUE
      return OUTPUT
    }
    let answer: Scanned | null = null
    this.lastChWasWs = false
    if (this.state === ParseState.NORMAL) {
      const literal = WHITESPACE[ch] === 0 && STRUCTURE[ch] === 0 && ch !== QUOTE
      if (WHITESPACE[ch] === 1) this.lastChWasWs = true
      if (!literal) {
        const msg = this.checkLiteral()
        if (msg !== null) return msg
        const done = this.checkDone()
        if (done !== NO_VALUE) {
          this.produced = done
          this.before = true
          answer = OUTPUT
        }
      }
      if (literal) {
        this.token.push(ch)
      } else if (ch === QUOTE) {
        this.state = ParseState.STRING
      } else if (STRUCTURE[ch] === 1) {
        const msg = this.streaming ? this.streamToken(ch) : this.parseToken(ch)
        if (msg !== null) return msg
      }
      const done = this.checkDone()
      if (done !== NO_VALUE) {
        this.produced = done
        this.before = false
        answer = OUTPUT
      }
    } else if (ch === QUOTE && this.state === ParseState.STRING) {
      const msg = this.foundString()
      if (msg !== null) return msg
      this.state = ParseState.NORMAL
      const done = this.checkDone()
      if (done !== NO_VALUE) {
        this.produced = done
        this.before = false
        answer = OUTPUT
      }
    } else {
      this.token.push(ch)
      this.state =
        ch === BACKSLASH && this.state === ParseState.STRING
          ? ParseState.STRING_ESCAPE
          : ParseState.STRING
    }
    return answer
  }

  private checkLiteral(): string | null {
    const token = this.token.view()
    if (token.length === 0) return null
    const first = token[0]
    let pattern: string | null = null
    let value: unknown = null
    if (first === LOWER_T) {
      pattern = 'true'
      value = true
    } else if (first === LOWER_F) {
      pattern = 'false'
      value = false
    } else if (first === APOSTROPHE) {
      return 'Invalid string literal; expected ", but got \''
    } else if (first === LOWER_N && token.length > 1 && token[1] === LOWER_U) {
      pattern = 'null'
      value = null
    }
    if (pattern !== null) {
      if (!spells(token, pattern)) return 'Invalid literal'
    } else {
      const nul = token.indexOf(0)
      const literal = latin1(nul < 0 ? token : token.subarray(0, nul))
      const number = numberValue(literal)
      if (number === NO_VALUE) return 'Invalid numeric literal'
      value = this.streaming ? new NumberText(literal) : number
    }
    const msg = this.value(value)
    if (msg !== null) return msg
    this.token.clear()
    return null
  }

  private foundString(): string | null {
    const token = this.token.view()
    const end = token.length
    const out = new Uint8Array(end)
    let written = 0
    let at = 0
    for (;;) {
      const slash = token.indexOf(BACKSLASH, at)
      const stop = slash < 0 ? end : slash
      for (let i = at; i < stop; i += 1) if ((token[i] ?? 0) < SPACE) return CONTROL_CHARACTER
      out.set(token.subarray(at, stop), written)
      written += stop - at
      if (slash < 0) break
      at = slash + 1
      if (at >= end) return 'Expected escape character at end of string'
      const code = token[at] ?? 0
      at += 1
      const plain = ESCAPES.get(code)
      if (plain !== undefined) {
        out[written] = plain
        written += 1
        continue
      }
      if (code !== LOWER_U) return 'Invalid escape'
      if (at + 4 > end) return 'Invalid \\uXXXX escape'
      let point = unhex4(token, at)
      if (point < 0) return 'Invalid characters in \\uXXXX escape'
      at += 4
      if (point >= 0xd800 && point <= 0xdbff) {
        if (at + 6 > end || token[at] !== BACKSLASH || token[at + 1] !== LOWER_U) {
          return SURROGATE_PAIR
        }
        const low = unhex4(token, at + 2)
        if (!(low >= 0xdc00 && low <= 0xdfff)) return SURROGATE_PAIR
        at += 6
        point = 0x10000 + (((point - 0xd800) << 10) | (low - 0xdc00))
      }
      written += encodeUtf8(point, out, written)
    }
    const msg = this.value(decodeUtf8(out.subarray(0, written)))
    if (msg !== null) return msg
    this.token.clear()
    return null
  }

  private parseToken(ch: number): string | null {
    const stack = this.stack
    if (ch === OPEN_BRACKET || ch === OPEN_BRACE) {
      if (stack.length >= MAX_PARSING_DEPTH) return DEPTH_EXCEEDED
      if (this.nextValue !== NO_VALUE) return EXPECTED_SEPARATOR
      stack.push(ch === OPEN_BRACKET ? [] : {})
    } else if (ch === COLON) {
      if (this.nextValue === NO_VALUE) return "Expected string key before ':'"
      if (!isObject(stack[stack.length - 1])) return "':' not as part of an object"
      if (typeof this.nextValue !== 'string') return 'Object keys must be strings'
      stack.push(this.nextValue)
      this.nextValue = NO_VALUE
    } else if (ch === COMMA) {
      if (this.nextValue === NO_VALUE) return "Expected value before ','"
      if (stack.length === 0) return "',' not as part of an object or array"
      const top = stack[stack.length - 1]
      if (Array.isArray(top)) {
        top.push(this.nextValue)
      } else if (typeof top === 'string') {
        setKey(stack[stack.length - 2] as Record<string, unknown>, top, this.nextValue)
        stack.pop()
      } else {
        return 'Objects must consist of key:value pairs'
      }
      this.nextValue = NO_VALUE
    } else if (ch === CLOSE_BRACKET) {
      const top = stack[stack.length - 1]
      if (!Array.isArray(top)) return "Unmatched ']'"
      if (this.nextValue !== NO_VALUE) {
        top.push(this.nextValue)
      } else if (top.length > 0) {
        return 'Expected another array element'
      }
      this.nextValue = stack.pop()
    } else if (ch === CLOSE_BRACE) {
      if (stack.length === 0) return "Unmatched '}'"
      const top = stack[stack.length - 1]
      if (this.nextValue !== NO_VALUE) {
        if (typeof top !== 'string') return 'Objects must consist of key:value pairs'
        setKey(stack[stack.length - 2] as Record<string, unknown>, top, this.nextValue)
        stack.pop()
      } else {
        if (!isObject(top)) return "Unmatched '}'"
        if (Object.keys(top).length > 0) return 'Expected another key-value pair'
      }
      this.nextValue = stack.pop()
    }
    return null
  }

  private streamToken(ch: number): string | null {
    const path = this.path
    const lastSeen = this.lastSeen
    if ((ch === OPEN_BRACKET || ch === OPEN_BRACE) && path.length >= MAX_PARSING_DEPTH) {
      return DEPTH_EXCEEDED
    }
    if (ch === OPEN_BRACKET) {
      if (this.nextValue !== NO_VALUE) return 'Expected a separator between values'
      if (lastSeen === LastSeen.OPEN_OBJECT) return "Expected string key after '{', not '['"
      if (lastSeen === LastSeen.COMMA && !isNumber(path[path.length - 1])) {
        return "Expected string key after ',' in object, not '['"
      }
      path.push(0)
      this.lastSeen = LastSeen.OPEN_ARRAY
    } else if (ch === OPEN_BRACE) {
      if (lastSeen === LastSeen.VALUE) return 'Expected a separator between values'
      if (lastSeen === LastSeen.OPEN_OBJECT) return "Expected string key after '{', not '{'"
      if (lastSeen === LastSeen.COMMA && !isNumber(path[path.length - 1])) {
        return "Expected string key after ',' in object, not '{'"
      }
      path.push(null)
      this.lastSeen = LastSeen.OPEN_OBJECT
    } else if (ch === COLON) {
      if (path.length === 0 || isNumber(path[path.length - 1])) {
        return "':' not as part of an object"
      }
      if (this.nextValue === NO_VALUE || lastSeen === LastSeen.NONE) {
        return "Expected string key before ':'"
      }
      if (typeof this.nextValue !== 'string') return 'Object keys must be strings'
      if (lastSeen !== LastSeen.VALUE) return "':' should follow a key"
      this.lastSeen = LastSeen.COLON
      path[path.length - 1] = this.nextValue
      this.nextValue = NO_VALUE
    } else if (ch === COMMA) {
      if (lastSeen !== LastSeen.VALUE) return "Expected value before ','"
      if (path.length === 0) return "',' not as part of an object or array"
      const last = path[path.length - 1]
      if (isNumber(last)) {
        if (this.nextValue !== NO_VALUE) {
          this.output = [[...path], this.nextValue]
          this.nextValue = NO_VALUE
        }
        path[path.length - 1] = last + 1
      } else if (typeof last === 'string') {
        if (this.nextValue !== NO_VALUE) {
          this.output = [[...path], this.nextValue]
          this.nextValue = NO_VALUE
        }
        path[path.length - 1] = null
      } else {
        return 'Objects must consist of key:value pairs'
      }
      this.lastSeen = LastSeen.COMMA
    } else if (ch === CLOSE_BRACKET) {
      if (path.length === 0) return "Unmatched ']' at the top-level"
      if (lastSeen === LastSeen.COMMA) return 'Expected another array element'
      if (!isNumber(path[path.length - 1])) return "Unmatched ']' in the middle of an object"
      if (this.nextValue !== NO_VALUE) {
        this.output = [[...path], this.nextValue, true]
      } else if (lastSeen !== LastSeen.OPEN_ARRAY) {
        this.output = [[...path]]
      }
      path.pop()
      this.nextValue = NO_VALUE
      if (lastSeen === LastSeen.OPEN_ARRAY) this.output = [[...path], []]
      this.lastSeen = path.length > 0 ? LastSeen.VALUE : LastSeen.NONE
    } else if (ch === CLOSE_BRACE) {
      if (path.length === 0) return "Unmatched '}' at the top-level"
      if (lastSeen === LastSeen.COMMA) return 'Expected another key:value pair'
      const last = path[path.length - 1]
      if (isNumber(last)) return "Unmatched '}' in the middle of an array"
      if (this.nextValue !== NO_VALUE) {
        if (typeof last !== 'string') return 'Objects must consist of key:value pairs'
        this.output = [[...path], this.nextValue, true]
      } else {
        if (lastSeen === LastSeen.COLON) return 'Missing value in key:value pair'
        if (lastSeen === LastSeen.OPEN_ARRAY) return "Unmatched '}' in the middle of an array"
        if (lastSeen !== LastSeen.VALUE && lastSeen !== LastSeen.OPEN_OBJECT) {
          return "Unmatched '}'"
        }
        if (lastSeen !== LastSeen.OPEN_OBJECT) this.output = [[...path]]
      }
      path.pop()
      this.nextValue = NO_VALUE
      if (lastSeen === LastSeen.OPEN_OBJECT) this.output = [[...path], {}]
      this.lastSeen = path.length > 0 ? LastSeen.VALUE : LastSeen.NONE
    }
    return null
  }
}
