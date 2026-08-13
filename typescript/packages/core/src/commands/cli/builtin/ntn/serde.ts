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

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const EOF_LIST = 'EOF while parsing a list'
const EOF_OBJECT = 'EOF while parsing an object'
const EOF_STRING = 'EOF while parsing a string'
const EOF_VALUE = 'EOF while parsing a value'
const EXPECTED_COLON = 'expected `:`'
const EXPECTED_IDENT = 'expected ident'
const EXPECTED_LIST_END = 'expected `,` or `]`'
const EXPECTED_OBJECT_END = 'expected `,` or `}`'
const EXPECTED_VALUE = 'expected value'
const INVALID_ESCAPE = 'invalid escape'
const INVALID_NUMBER = 'invalid number'
const KEY_MUST_BE_STRING = 'key must be a string'
const NUMBER_OUT_OF_RANGE = 'number out of range'
const RECURSION_LIMIT = 'recursion limit exceeded'
const STRING_CONTROL = 'control character (\\u0000-\\u001F) found while parsing a string'
const TRAILING_CHARACTERS = 'trailing characters'
const TRAILING_COMMA = 'trailing comma'
const UNEXPECTED_HEX_END = 'unexpected end of hex escape'

// serde_json's own default depth, probed: 127 nested lists parse and the
// 128th is refused, at the column of its opening bracket.
const MAX_DEPTH = 127

const BRACE_OPEN = 0x7b
const BRACE_CLOSE = 0x7d
const BRACKET_OPEN = 0x5b
const BRACKET_CLOSE = 0x5d
const BACKSLASH = 0x5c
const COLON = 0x3a
const COMMA = 0x2c
const DOT = 0x2e
const MINUS = 0x2d
const NEWLINE = 0x0a
const PLUS = 0x2b
const QUOTE = 0x22
const SPACE = 0x20
const ZERO = 0x30
const LOWER_E = 0x65
const UPPER_E = 0x45
const LOWER_U = 0x75

const HEX_DIGITS = new Set(ENC.encode('0123456789ABCDEFabcdef'))
const SHORT_ESCAPES = new Set(ENC.encode('"\\/bfnrt'))
const WHITESPACE = new Set(ENC.encode(' \n\r\t'))
const IDENTS = new Map<number, Uint8Array>([
  [0x74, ENC.encode('true')],
  [0x66, ENC.encode('false')],
  [0x6e, ENC.encode('null')],
])
const LEAD_SURROGATE_LOW = 0xd800
const LEAD_SURROGATE_HIGH = 0xdbff
const HEX_WIDTH = 4

class SerdeRefusal extends Error {}

function isDigit(byte: number | null): boolean {
  return byte !== null && byte >= ZERO && byte <= ZERO + 9
}

// A JSON scanner that refuses in serde_json's exact words.
//
// mirage's `ntn` has to reject a malformed inline input the way the Rust
// binary does, and that wording is serde_json's own, down to a byte column.
// Neither engine parser can supply it: JSON.parse and python's `json` each
// have their own vocabulary and their own idea of a position, and the two do
// not even agree with each other. So this scanner decides validity, and
// JSON.parse only ever runs on input it has already accepted.
//
// Two position rules, both probed against ntn 0.21.9: columns count bytes,
// not characters (`["é"x` fails at column 6), and a newline advances the line
// and resets the column to 0. The reported column is the 1-based offset of
// the last byte read, which at end of input is the length of the line.
class SerdeScan {
  private readonly raw: Uint8Array
  private at = 0
  private line = 1
  private lineStart = 0
  private depth = 0

  constructor(text: string) {
    this.raw = ENC.encode(text)
  }

  private get column(): number {
    return this.at - this.lineStart
  }

  private fail(code: string): SerdeRefusal {
    return new SerdeRefusal(`${code} at line ${String(this.line)} column ${String(this.column)}`)
  }

  private peek(): number | null {
    // `??` and not `||`: a zero byte is a real byte, not an absent one.
    return this.raw[this.at] ?? null
  }

  private take(): number | null {
    const byte = this.raw[this.at]
    if (byte === undefined) return null
    this.at += 1
    if (byte === NEWLINE) {
      this.line += 1
      this.lineStart = this.at
    }
    return byte
  }

  // serde reports a short `\u` escape at the end of the buffer, and it
  // derives line and column by scanning what it skipped, so this cannot
  // shortcut to the length.
  private drain(): void {
    while (this.take() !== null) continue
  }

  private skipWs(): void {
    for (;;) {
      const byte = this.peek()
      if (byte === null || !WHITESPACE.has(byte)) return
      this.take()
    }
  }

  private enter(): void {
    this.depth += 1
    if (this.depth > MAX_DEPTH) throw this.fail(RECURSION_LIMIT)
  }

  document(): void {
    this.value()
    this.skipWs()
    if (this.peek() !== null) {
      this.take()
      throw this.fail(TRAILING_CHARACTERS)
    }
  }

  private value(): void {
    this.skipWs()
    const head = this.peek()
    if (head === null) throw this.fail(EOF_VALUE)
    if (head === BRACE_OPEN) {
      this.take()
      this.obj()
      return
    }
    if (head === BRACKET_OPEN) {
      this.take()
      this.arr()
      return
    }
    if (head === QUOTE) {
      this.take()
      this.string()
      return
    }
    const word = IDENTS.get(head)
    if (word !== undefined) {
      this.ident(word)
      return
    }
    if (head === MINUS || isDigit(head)) {
      this.number()
      return
    }
    this.take()
    throw this.fail(EXPECTED_VALUE)
  }

  private obj(): void {
    this.enter()
    this.skipWs()
    if (this.peek() === null) throw this.fail(EOF_OBJECT)
    if (this.peek() === BRACE_CLOSE) {
      this.take()
      this.depth -= 1
      return
    }
    for (;;) {
      this.skipWs()
      const key = this.peek()
      if (key === null) throw this.fail(EOF_OBJECT)
      if (key !== QUOTE) {
        this.take()
        throw this.fail(KEY_MUST_BE_STRING)
      }
      this.take()
      this.string()
      this.skipWs()
      const colon = this.take()
      if (colon === null) throw this.fail(EOF_OBJECT)
      if (colon !== COLON) throw this.fail(EXPECTED_COLON)
      this.value()
      this.skipWs()
      const sep = this.take()
      if (sep === null) throw this.fail(EOF_OBJECT)
      if (sep === BRACE_CLOSE) {
        this.depth -= 1
        return
      }
      if (sep !== COMMA) throw this.fail(EXPECTED_OBJECT_END)
      // Past a comma the next key is read as a value would be, so a closing
      // brace is the trailing comma and end of input is the value error, not
      // the object one that an unterminated `{` reports.
      this.skipWs()
      if (this.peek() === BRACE_CLOSE) {
        this.take()
        throw this.fail(TRAILING_COMMA)
      }
      if (this.peek() === null) throw this.fail(EOF_VALUE)
    }
  }

  private arr(): void {
    this.enter()
    this.skipWs()
    if (this.peek() === null) throw this.fail(EOF_LIST)
    if (this.peek() === BRACKET_CLOSE) {
      this.take()
      this.depth -= 1
      return
    }
    for (;;) {
      this.value()
      this.skipWs()
      const sep = this.take()
      if (sep === null) throw this.fail(EOF_LIST)
      if (sep === BRACKET_CLOSE) {
        this.depth -= 1
        return
      }
      if (sep !== COMMA) throw this.fail(EXPECTED_LIST_END)
      // Only a closing bracket is the trailing-comma case. End of input
      // falls through to the next value, which is why `[1,` is a value error
      // and `[1,]` is a comma one.
      this.skipWs()
      if (this.peek() === BRACKET_CLOSE) {
        this.take()
        throw this.fail(TRAILING_COMMA)
      }
    }
  }

  private string(): void {
    for (;;) {
      const byte = this.take()
      if (byte === null) throw this.fail(EOF_STRING)
      if (byte === QUOTE) return
      if (byte === BACKSLASH) {
        this.escape()
        continue
      }
      if (byte < SPACE) throw this.fail(STRING_CONTROL)
    }
  }

  private escape(): void {
    const marker = this.take()
    if (marker === null) throw this.fail(EOF_STRING)
    if (SHORT_ESCAPES.has(marker)) return
    if (marker !== LOWER_U) throw this.fail(INVALID_ESCAPE)
    const code = this.hexEscape()
    if (code < LEAD_SURROGATE_LOW || code > LEAD_SURROGATE_HIGH) return
    const opener = this.take()
    if (opener === null) throw this.fail(EOF_STRING)
    if (opener !== BACKSLASH) throw this.fail(UNEXPECTED_HEX_END)
    const second = this.take()
    if (second === null) throw this.fail(EOF_STRING)
    if (second !== LOWER_U) throw this.fail(UNEXPECTED_HEX_END)
    this.hexEscape()
  }

  private hexEscape(): number {
    // serde checks that four bytes remain before reading any of them, so a
    // short escape is end-of-string at the buffer's end rather than a bad
    // digit where it ran out.
    if (this.at + HEX_WIDTH > this.raw.length) {
      this.drain()
      throw this.fail(EOF_STRING)
    }
    const chunk = this.raw.slice(this.at, this.at + HEX_WIDTH)
    for (let step = 0; step < HEX_WIDTH; step += 1) this.take()
    for (const byte of chunk) {
      if (!HEX_DIGITS.has(byte)) throw this.fail(INVALID_ESCAPE)
    }
    return Number.parseInt(DEC.decode(chunk), 16)
  }

  private ident(word: Uint8Array): void {
    for (const expected of word) {
      const byte = this.take()
      if (byte === null) throw this.fail(EOF_VALUE)
      if (byte !== expected) throw this.fail(EXPECTED_IDENT)
    }
  }

  private digits(): void {
    while (isDigit(this.peek())) this.take()
  }

  // A digit run the grammar requires to be non-empty.
  private runDigits(): void {
    const first = this.take()
    if (first === null) throw this.fail(EOF_VALUE)
    if (!isDigit(first)) throw this.fail(INVALID_NUMBER)
    this.digits()
  }

  private number(): void {
    const start = this.at
    if (this.peek() === MINUS) this.take()
    const lead = this.take()
    if (lead === null) throw this.fail(EOF_VALUE)
    if (!isDigit(lead)) throw this.fail(INVALID_NUMBER)
    if (lead === ZERO) {
      if (isDigit(this.peek())) {
        this.take()
        throw this.fail(INVALID_NUMBER)
      }
    } else {
      this.digits()
    }
    if (this.peek() === DOT) {
      this.take()
      this.runDigits()
    }
    const exponent = this.peek()
    if (exponent === LOWER_E || exponent === UPPER_E) {
      this.take()
      const sign = this.peek()
      if (sign === PLUS || sign === MINUS) this.take()
      this.runDigits()
    }
    // An integer too wide for u64/i64 becomes an f64 in serde too, so
    // overflow is the one range error either shape can hit.
    if (!Number.isFinite(Number(DEC.decode(this.raw.slice(start, this.at))))) {
      throw this.fail(NUMBER_OUT_OF_RANGE)
    }
  }
}

// serde_json's parse error for `text`, or null if serde would accept it.
export function serdeMessage(text: string): string | null {
  const scan = new SerdeScan(text)
  try {
    scan.document()
  } catch (err) {
    if (err instanceof SerdeRefusal) return err.message
    throw err
  }
  return null
}
