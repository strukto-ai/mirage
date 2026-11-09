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

import type { JsonValue } from '../../types.ts'

const ANONYMOUS_BOUNDARY = new Uint8Array(0)
const MAX_NESTED = 3
const HEADER_NAMES: Record<string, string> = {
  subject: 'subject',
  from: 'from',
  to: 'to',
  cc: 'cc',
  date: 'date',
  bcc: 'bcc',
  'reply-to': 'reply_to',
  sender: 'sender',
  comments: 'comments',
  'in-reply-to': 'in_reply_to',
  keywords: 'keywords',
  received: 'received',
  'message-id': 'message_id',
  references: 'references',
  'return-path': 'return_path',
  'mime-version': 'mime_version',
  'content-description': 'content_description',
  'content-id': 'content_id',
  'content-language': 'content_language',
  'content-location': 'content_location',
  'content-transfer-encoding': 'content_transfer_encoding',
  'content-type': 'content_type',
  'content-disposition': 'content_disposition',
  'resent-to': 'resent_to',
  'resent-from': 'resent_from',
  'resent-bcc': 'resent_bcc',
  'resent-cc': 'resent_cc',
  'resent-sender': 'resent_sender',
  'resent-date': 'resent_date',
  'resent-message-id': 'resent_message_id',
  'list-archive': 'list_archive',
  'list-help': 'list_help',
  'list-id': 'list_id',
  'list-owner': 'list_owner',
  'list-post': 'list_post',
  'list-subscribe': 'list_subscribe',
  'list-unsubscribe': 'list_unsubscribe',
}
const UNSTRUCTURED = new Set([
  'subject',
  'comments',
  'content_description',
  'content_location',
  'content_transfer_encoding',
])
const ADDRESSES = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply_to',
  'sender',
  'resent_to',
  'resent_from',
  'resent_bcc',
  'resent_cc',
  'resent_sender',
  'list_archive',
  'list_help',
  'list_id',
  'list_owner',
  'list_post',
  'list_subscribe',
  'list_unsubscribe',
])
const IDS = new Set([
  'message_id',
  'references',
  'in_reply_to',
  'return_path',
  'content_id',
  'resent_message_id',
])
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}
const OBSOLETE_ZONES: Record<string, number> = {
  ut: 0,
  gmt: 0,
  est: -5,
  edt: -4,
  cst: -6,
  cdt: -5,
  mst: -7,
  mdt: -6,
  pst: -8,
  pdt: -7,
}
const SPACE = new Set([0x20, 0x09])
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0c, 0x0d])
const HEX_DIGITS = new Set(new TextEncoder().encode('0123456789abcdefABCDEF'))
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUE = new Map(
  Array.from(BASE64_CHARS).map((char, index) => [char.charCodeAt(0), index]),
)
const DASH = 0x2d
const NEWLINE = 0x0a
const RETURN = 0x0d
const ENCODING_PROBLEM = -1

const DEC = new TextDecoder('utf-8')
const ENC = new TextEncoder()

export type MimeValue = JsonValue

export type MimeHeaderName = string | { other: string }

export interface MimeHeader {
  name: MimeHeaderName
  value: MimeValue
  offset_field: number
  offset_start: number
  offset_end: number
}

export type MimeBody =
  | { Text: string }
  | { Html: string }
  | { Binary: number[] }
  | { InlineBinary: number[] }
  | { Message: MimeMessage }
  | { Multipart: number[] }

export interface MimePart {
  headers: MimeHeader[]
  is_encoding_problem: boolean
  body: MimeBody
  offset_header: number
  offset_body: number
  offset_end: number
}

enum Kind {
  MIXED,
  ALTERNATIVE,
  RELATED,
  DIGEST,
  PLAIN,
  HTML,
  TEXT_OTHER,
  INLINE,
  MESSAGE,
  OTHER,
}

function text(data: Uint8Array): string {
  return DEC.decode(data)
}

/** Bytes as text in a declared charset, UTF-8 when it is unknown. */
function decodeCharset(data: Uint8Array, charset: string | null): string {
  if (charset !== null && charset !== '') {
    try {
      return new TextDecoder(charset).decode(data)
    } catch {
      return text(data)
    }
  }
  return text(data)
}

function concat(chunks: number[]): Uint8Array {
  return Uint8Array.from(chunks)
}

function isHex(byte: number): boolean {
  return HEX_DIGITS.has(byte)
}

function hexValue(high: number, low: number): number {
  return Number.parseInt(String.fromCharCode(high, low), 16)
}

function partialBase64(group: number[], keep: number): number[] {
  const values = [...group]
  while (values.length < 4) values.push(0x41)
  const bits =
    ((BASE64_VALUE.get(values[0] ?? 0) ?? 0) << 18) |
    ((BASE64_VALUE.get(values[1] ?? 0) ?? 0) << 12) |
    ((BASE64_VALUE.get(values[2] ?? 0) ?? 0) << 6) |
    (BASE64_VALUE.get(values[3] ?? 0) ?? 0)
  return [(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff].slice(0, keep)
}

function decodeQWord(body: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    const byte = body[index] ?? 0
    if (byte === 0x5f) {
      out.push(0x20)
    } else if (
      byte === 0x3d &&
      index + 2 < body.length &&
      isHex(body[index + 1] ?? 0) &&
      isHex(body[index + 2] ?? 0)
    ) {
      out.push(hexValue(body[index + 1] ?? 0, body[index + 2] ?? 0))
      index += 2
    } else {
      out.push(byte)
    }
  }
  return concat(out)
}

function base64Decode(body: Uint8Array): Uint8Array {
  const out: number[] = []
  let group: number[] = []
  for (const byte of body) {
    if (!BASE64_VALUE.has(byte)) continue
    group.push(byte)
    if (group.length === 4) {
      out.push(...partialBase64(group, 3))
      group = []
    }
  }
  if (group.length === 2) out.push(...partialBase64(group, 1))
  if (group.length === 3) out.push(...partialBase64(group, 2))
  return concat(out)
}

function isAlpha(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
}

/** A cursor over raw message bytes. */
export class Stream {
  pos = 0
  mark = 0

  constructor(readonly data: Uint8Array) {}

  next(): number | null {
    const byte = this.data[this.pos]
    if (byte === undefined) return null
    this.pos += 1
    return byte
  }

  peek(): number | null {
    return this.data[this.pos] ?? null
  }

  checkpoint(): void {
    this.mark = this.pos
  }

  restore(): void {
    this.pos = this.mark
  }

  peekChar(char: number): boolean {
    return this.peek() === char
  }

  peekNextIsSpace(): boolean {
    const byte = this.peek()
    return byte !== null && SPACE.has(byte)
  }

  tryNextIsSpace(): boolean {
    if (this.peekNextIsSpace()) {
      this.pos += 1
      return true
    }
    return false
  }

  trySkip(word: Uint8Array): boolean {
    if (this.pos + word.length > this.data.length) return false
    for (let index = 0; index < word.length; index += 1) {
      if (this.data[this.pos + index] !== word[index]) return false
    }
    this.pos += word.length
    return true
  }

  slice(start: number, end: number): Uint8Array {
    return this.data.subarray(start, end)
  }

  skipCrlf(): void {
    for (;;) {
      const byte = this.peek()
      if (byte === null) return
      if (byte === RETURN || byte === 0x20 || byte === 0x09) {
        this.pos += 1
      } else if (byte === NEWLINE) {
        this.pos += 1
        return
      } else {
        return
      }
    }
  }

  seekNextPart(boundary: Uint8Array): boolean {
    if (boundary.length > 0) {
      let last = 0
      this.checkpoint()
      for (let byte = this.next(); byte !== null; byte = this.next()) {
        if (byte === DASH && last === DASH && this.trySkip(boundary)) return true
        last = byte
      }
      this.restore()
    }
    return false
  }

  seekNextPartOffset(boundary: Uint8Array): number | null {
    let last = NEWLINE
    let offset = this.pos
    this.checkpoint()
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        offset = this.pos - (last === RETURN ? 2 : 1)
      } else if (byte === DASH && last === DASH && this.trySkip(boundary)) {
        return offset
      }
      last = byte
    }
    this.restore()
    return null
  }

  mimePart(boundary: Uint8Array): [number, Uint8Array] {
    let last = NEWLINE
    let before = 0
    const start = this.pos
    let end = this.pos
    this.checkpoint()
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        end = this.pos - (last === RETURN ? 2 : 1)
      } else if (byte === DASH && boundary.length > 0 && last === DASH && this.trySkip(boundary)) {
        if (before !== NEWLINE) end = this.pos - boundary.length - 2
        return [end, this.slice(start, end)]
      }
      before = last
      last = byte
    }
    if (boundary.length === 0) return [this.pos, this.slice(start, this.data.length)]
    this.restore()
    return [ENCODING_PROBLEM, this.slice(start, this.data.length)]
  }

  seekPartEnd(boundary: Uint8Array | null): [number, boolean] {
    let last = NEWLINE
    let before = 0
    let end = this.pos
    if (boundary === null) {
      this.pos = this.data.length
      return [this.pos, true]
    }
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        end = this.pos - (last === RETURN ? 2 : 1)
      } else if (byte === DASH && last === DASH && this.trySkip(boundary)) {
        if (before !== NEWLINE) end = this.pos - boundary.length - 2
        return [end, true]
      }
      before = last
      last = byte
    }
    return [this.pos, false]
  }

  isMultipartEnd(): boolean {
    this.checkpoint()
    const first = this.next()
    const second = this.peek()
    if (first === RETURN && second === NEWLINE) {
      this.pos += 1
      return false
    }
    if (first === DASH && second === DASH) {
      this.pos += 1
      return true
    }
    if (first === NEWLINE) return false
    if (first !== null && WHITESPACE.has(first)) {
      this.skipCrlf()
      return false
    }
    this.restore()
    return false
  }

  decodeBase64(boundary: Uint8Array): [number, Uint8Array] {
    const data: number[] = []
    let group: number[] = []
    let last = NEWLINE
    let before = 0
    let end = this.pos
    this.checkpoint()
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (BASE64_VALUE.has(byte)) {
        group.push(byte)
        if (group.length === 4) {
          data.push(...partialBase64(group, 3))
          group = []
        }
      } else if (byte === 0x3d) {
        if (group.length === 1 || group.length === 2) {
          data.push(...partialBase64(group, 1))
          group = []
        } else if (group.length === 3) {
          data.push(...partialBase64(group, 2))
          group = []
        }
      } else if (byte === NEWLINE) {
        end = this.pos - (last === RETURN ? 2 : 1)
      } else if (byte === 0x20 || byte === 0x09 || byte === RETURN) {
        // Whitespace inside encoded lines is ignored.
      } else if (byte === DASH) {
        if (last === DASH) {
          if (boundary.length > 0 && this.trySkip(boundary)) {
            return [before === NEWLINE ? end : this.pos - boundary.length - 2, concat(data)]
          }
          this.restore()
          return [ENCODING_PROBLEM, new Uint8Array(0)]
        }
      } else {
        this.restore()
        return [ENCODING_PROBLEM, new Uint8Array(0)]
      }
      before = last
      last = byte
    }
    if (boundary.length > 0) {
      this.restore()
      return [ENCODING_PROBLEM, new Uint8Array(0)]
    }
    return [this.pos, concat(data)]
  }

  decodeQuotedPrintable(boundary: Uint8Array): [number, Uint8Array] {
    const data: number[] = []
    let state = 0
    let high = 0
    let last = 0
    let before = 0
    let spaces = 0
    let end = this.pos
    let crlf = [NEWLINE]
    this.checkpoint()
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === 0x3d) {
        if (state !== 0) {
          this.restore()
          return [ENCODING_PROBLEM, new Uint8Array(0)]
        }
        state = 1
      } else if (byte === NEWLINE) {
        end = this.pos - (last === RETURN ? 2 : 1)
        if (state === 1) {
          state = 0
        } else {
          if (spaces > 0) data.length -= spaces
          data.push(...crlf)
        }
        spaces = 0
      } else if (byte === RETURN) {
        crlf = [RETURN, NEWLINE]
      } else if (byte === DASH && boundary.length > 0 && last === DASH && this.trySkip(boundary)) {
        if (before === NEWLINE) {
          data.length -= crlf.length + 1
        } else {
          data.length -= 1
          end = this.pos - boundary.length - 2
        }
        return [end, concat(data)]
      } else if (state === 0) {
        spaces = WHITESPACE.has(byte) ? spaces + 1 : 0
        data.push(byte)
      } else if (state === 1) {
        if (isHex(byte)) {
          high = byte
          state = 2
        } else if (!WHITESPACE.has(byte)) {
          state = 0
          data.push(0x3d, byte)
          spaces = 0
        }
      } else {
        state = 0
        if (isHex(byte)) {
          data.push(hexValue(high, byte))
          spaces = 0
        } else {
          data.push(0x3d, high, byte)
        }
      }
      before = last
      last = byte
    }
    if (boundary.length > 0) {
      this.restore()
      return [ENCODING_PROBLEM, new Uint8Array(0)]
    }
    return [this.pos, concat(data)]
  }

  decodeRfc2047(): string | null {
    if (this.next() !== 0x3f) return null
    const charsetStart = this.pos
    let charsetEnd = this.pos
    for (;;) {
      const byte = this.next()
      if (byte === null || byte === NEWLINE) return null
      if (byte === 0x3f) {
        if (charsetEnd === charsetStart) charsetEnd = this.pos - 1
        if (charsetEnd - charsetStart < 2) return null
        break
      }
      if (byte === 0x2a && charsetEnd === charsetStart) charsetEnd = this.pos - 1
    }
    const method = this.next()
    if (method === null || !'qQbB'.includes(String.fromCharCode(method))) return null
    if (this.next() !== 0x3f) return null
    const start = this.pos
    let close = -1
    for (let at = start; at + 1 < this.data.length; at += 1) {
      if (this.data[at] === 0x3f && this.data[at + 1] === 0x3d) {
        close = at
        break
      }
    }
    if (close < 0) return null
    const body = this.slice(start, close)
    if (body.includes(NEWLINE)) return null
    this.pos = close + 2
    const charset = text(this.slice(charsetStart, charsetEnd))
    const decoded = 'bB'.includes(String.fromCharCode(method))
      ? base64Decode(body)
      : decodeQWord(body)
    return decodeCharset(decoded, charset)
  }

  parseRaw(): MimeValue {
    let start = 0
    let end = 0
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        if (!this.tryNextIsSpace()) break
        continue
      }
      if (byte === 0x20 || byte === 0x09 || byte === RETURN) continue
      if (start === 0) start = this.pos
      end = this.pos
    }
    if (start > 0) return { Text: text(this.slice(start - 1, end)) }
    return 'Empty'
  }

  parseUnstructured(): MimeValue {
    const tokens: string[] = []
    let start = 0
    let end = 0
    let lastEncoded = true as boolean
    const flush = (): void => {
      if (start > 0) {
        if (tokens.length > 0) tokens.push(' ')
        tokens.push(text(this.slice(start - 1, end)))
        start = 0
        lastEncoded = false
      }
    }
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        flush()
        if (this.tryNextIsSpace()) continue
        if (tokens.length === 0) return 'Empty'
        return { Text: tokens.join('') }
      }
      if (byte === 0x20 || byte === 0x09 || byte === RETURN) continue
      if (byte === 0x3d && this.peekChar(0x3f)) {
        this.checkpoint()
        const token = this.decodeRfc2047()
        if (token !== null) {
          flush()
          if (!lastEncoded) tokens.push(' ')
          tokens.push(token)
          lastEncoded = true
          continue
        }
        this.restore()
      }
      if (start === 0) start = this.pos
      end = this.pos
    }
    return 'Empty'
  }

  parseId(): MimeValue {
    let start = 0
    let end = 0
    let looseStart = 0
    let looseEnd = 0
    let inside = false
    const ids: string[] = []
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        if (this.tryNextIsSpace()) continue
        if (ids.length === 1) return { Text: ids[0] ?? '' }
        if (ids.length === 0) {
          if (looseStart > 0) return { Text: text(this.slice(looseStart - 1, looseEnd)) }
          return 'Empty'
        }
        return { TextList: ids }
      }
      if (byte === 0x3c) {
        inside = true
        continue
      }
      if (byte === 0x3e) {
        inside = false
        if (start > 0) {
          ids.push(text(this.slice(start - 1, end)))
          start = 0
        }
        continue
      }
      if (byte === 0x20 || byte === 0x09 || byte === RETURN) continue
      if (inside) {
        if (start === 0) start = this.pos
        end = this.pos
      } else {
        if (looseStart === 0) looseStart = this.pos
        looseEnd = this.pos
      }
    }
    return 'Empty'
  }

  parseCommaSeparated(): MimeValue {
    const tokens: string[] = []
    const items: string[] = []
    let start = 0
    let end = 0
    let fresh = true
    const flush = (addSpace: boolean): void => {
      if (start > 0) {
        if (tokens.length > 0) tokens.push(' ')
        tokens.push(text(this.slice(start - 1, end)))
        if (addSpace) tokens.push(' ')
        start = 0
        fresh = true
      }
    }
    const collect = (): void => {
      if (tokens.length > 0) {
        items.push(tokens.join(''))
        tokens.length = 0
      }
    }
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === NEWLINE) {
        flush(false)
        if (this.tryNextIsSpace()) continue
        collect()
        if (items.length === 1) return { Text: items[0] ?? '' }
        return items.length > 0 ? { TextList: items } : 'Empty'
      }
      if (SPACE.has(byte)) {
        fresh = true
        continue
      }
      if (byte === 0x3d && fresh && this.peekChar(0x3f)) {
        this.checkpoint()
        const token = this.decodeRfc2047()
        if (token !== null) {
          flush(true)
          tokens.push(token)
          continue
        }
        this.restore()
      } else if (byte === 0x2c) {
        flush(false)
        collect()
        continue
      } else if (byte === RETURN) {
        continue
      }
      fresh = false
      if (start === 0) start = this.pos
      end = this.pos
    }
    return 'Empty'
  }

  parseDate(): MimeValue {
    return new DateParser(this).run()
  }

  parseAddress(): MimeValue {
    return new AddressParser(this).run()
  }

  parseContentType(): MimeValue {
    return new ContentTypeParser(this).run()
  }

  parseReceived(): MimeValue {
    return parseReceivedValue(this)
  }

  parseHeaderName(): MimeHeaderName | null {
    let start = 0
    let end = 0
    const name: number[] = []
    for (let byte = this.next(); byte !== null; byte = this.next()) {
      if (byte === 0x3a) {
        if (start !== 0) break
      } else if (byte === NEWLINE) {
        return null
      } else if (!WHITESPACE.has(byte)) {
        if (start === 0) start = this.pos
        end = this.pos
        name.push(byte)
      }
    }
    if (start === 0) return null
    const lowered = String.fromCharCode(...name).toLowerCase()
    return HEADER_NAMES[lowered] ?? { other: text(this.slice(start - 1, end)) }
  }

  parseHeaders(headers: MimeHeader[]): boolean {
    for (;;) {
      for (;;) {
        const byte = this.peek()
        if (byte === NEWLINE) {
          this.pos += 1
          return true
        }
        if (byte === null) return false
        if (WHITESPACE.has(byte)) {
          this.pos += 1
          continue
        }
        break
      }
      const offsetField = this.pos
      const name = this.parseHeaderName()
      if (name !== null) {
        const offsetStart = this.pos
        const value = this.parseValue(name)
        headers.push({
          name,
          value,
          offset_field: offsetField,
          offset_start: offsetStart,
          offset_end: this.pos,
        })
      } else if (this.peek() === null) {
        return false
      }
    }
  }

  parseValue(name: MimeHeaderName): MimeValue {
    if (typeof name !== 'string') return this.parseRaw()
    if (UNSTRUCTURED.has(name)) return this.parseUnstructured()
    if (ADDRESSES.has(name)) return this.parseAddress()
    if (name === 'date' || name === 'resent_date') return this.parseDate()
    if (IDS.has(name)) return this.parseId()
    if (name === 'keywords' || name === 'content_language') return this.parseCommaSeparated()
    if (name === 'received') return this.parseReceived()
    if (name === 'content_type' || name === 'content_disposition') return this.parseContentType()
    return this.parseRaw()
  }
}

const RECEIVED_PROTOCOLS = new Set([
  'SMTP',
  'ESMTP',
  'ESMTPA',
  'ESMTPS',
  'ESMTPSA',
  'LMTP',
  'LMTPA',
  'LMTPS',
  'LMTPSA',
  'MMS',
  'UTF8SMTP',
  'UTF8SMTPA',
  'UTF8SMTPS',
  'UTF8SMTPSA',
  'UTF8LMTP',
  'UTF8LMTPA',
  'UTF8LMTPS',
  'UTF8LMTPSA',
  'HTTP',
  'HTTPS',
  'IMAP',
  'POP3',
])
const RECEIVED_WORDS = new Set(['from', 'by', 'via', 'with', 'id', 'for'])

function isIp(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255)
  }
  return value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value)
}

function hostOf(word: string): MimeValue {
  const bare = word.replace(/^\[|\]$/g, '')
  return isIp(bare) ? { IpAddr: bare } : { Name: word }
}

function receivedTokens(value: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < value.length) {
    const char = value.charAt(index)
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    const start = index
    if (char === '(') {
      let depth = 0
      while (index < value.length) {
        if (value[index] === '(') depth += 1
        else if (value[index] === ')') {
          depth -= 1
          if (depth === 0) break
        }
        index += 1
      }
      index += 1
    } else {
      while (index < value.length && !/\s/.test(value.charAt(index)) && value[index] !== '(')
        index += 1
    }
    tokens.push(value.slice(start, index))
  }
  return tokens
}

function applyFromComment(received: Record<string, MimeValue>, comment: string): void {
  const inner = comment.slice(1, -1)
  const open = inner.lastIndexOf('[')
  const close = inner.lastIndexOf(']')
  if (open < 0 || close < open) return
  const address = inner.slice(open + 1, close).replace(/^IPv6:/, '')
  if (!isIp(address)) return
  received.from_ip = address
  const name = inner.slice(0, open).trim()
  if (name !== '' && !isIp(name) && !name.includes(' ')) received.from_iprev = name
}

/**
 * The fields of a Received header in its ordinary shape. Upstream's
 * tokenizer recognizes a long tail of relay-specific comment forms; this
 * reads the clause keywords and the date, which is what every conforming
 * relay writes.
 */
function parseReceivedValue(stream: Stream): MimeValue {
  const start = stream.pos
  let end = stream.pos
  for (let byte = stream.next(); ; byte = stream.next()) {
    if (byte === null) {
      end = stream.pos
      break
    }
    if (byte === NEWLINE && !stream.tryNextIsSpace()) {
      end = stream.pos
      break
    }
  }
  const value = text(stream.slice(start, end))
  const semicolon = value.lastIndexOf(';')
  const clauses = semicolon < 0 ? value : value.slice(0, semicolon)
  const tail = semicolon < 0 ? '' : value.slice(semicolon + 1)
  const received: Record<string, MimeValue> = {
    from: null,
    from_ip: null,
    from_iprev: null,
    by: null,
    for_: null,
    with: null,
    tls_version: null,
    tls_cipher: null,
    id: null,
    ident: null,
    helo: null,
    helo_cmd: null,
    via: null,
    date: null,
  }
  const words = receivedTokens(clauses)
  for (let index = 0; index < words.length;) {
    const word = (words[index] ?? '').toLowerCase()
    const next = words[index + 1]
    if (RECEIVED_WORDS.has(word) && next !== undefined) {
      if (word === 'from' && received.from === null) {
        received.from = hostOf(next)
        const following = words[index + 2] ?? ''
        if (following.startsWith('(')) applyFromComment(received, following)
      } else if (word === 'by' && received.by === null) {
        received.by = hostOf(next)
      } else if (word === 'with' && received.with === null) {
        const protocol = next.replace(/;$/, '').toUpperCase()
        if (RECEIVED_PROTOCOLS.has(protocol)) received.with = protocol
      } else if (word === 'id' && received.id === null) {
        received.id = next.replace(/;$/, '')
      } else if (word === 'for' && received.for_ === null) {
        received.for_ = next.replace(/^<|[>;]+$/g, '')
      } else if (word === 'via' && received.via === null) {
        received.via = next
      }
      index += 2
      continue
    }
    index += 1
  }
  if (tail.trim() !== '') {
    const parsed = new Stream(ENC.encode(`${tail.trim()}\n`)).parseDate()
    if (parsed !== null && typeof parsed === 'object' && 'DateTime' in parsed) {
      received.date = (parsed as { DateTime: MimeValue }).DateTime
    }
  }
  return { Received: received } as MimeValue
}

/** RFC 5322 dates, read as leniently as the parser real clients use. */
class DateParser {
  pos = 0
  parts = [0, 0, 0, 0, 0, 0, 0]
  sizes = [2, 2, 4, 2, 2, 2, 4]
  month = ''
  monthChars = 0
  plus = true
  fresh = true
  ignore = true

  constructor(private readonly stream: Stream) {}

  reset(): void {
    this.pos = 0
    this.parts = [0, 0, 0, 0, 0, 0, 0]
    this.sizes = [2, 2, 4, 2, 2, 2, 4]
    this.month = ''
    this.monthChars = 0
    this.plus = true
    this.fresh = true
    this.ignore = true
  }

  zone(first: number): void {
    let name = String.fromCharCode(first).toLowerCase()
    const stream = this.stream
    for (;;) {
      const byte = stream.peek()
      if (byte === null || !isAlpha(byte)) break
      name += String.fromCharCode(byte).toLowerCase()
      stream.pos += 1
    }
    const hours = OBSOLETE_ZONES[name] ?? 0
    this.plus = hours >= 0
    this.parts[6] = 100 * Math.abs(hours)
    this.sizes[6] = 0
  }

  run(): MimeValue {
    const stream = this.stream
    let comments = 0
    for (let byte = stream.next(); byte !== null; byte = stream.next()) {
      let advance = false
      if (byte === NEWLINE) {
        if (!stream.tryNextIsSpace()) break
        if (!this.fresh && !this.ignore && comments === 0) {
          advance = true
        } else {
          continue
        }
      } else if (comments > 0) {
        if (byte === 0x29) comments -= 1
        else if (byte === 0x28) comments += 1
        else if (byte === 0x5c && stream.peek() === 0x29) stream.pos += 1
        continue
      } else if (byte >= 0x30 && byte <= 0x39) {
        const size = this.sizes[this.pos] ?? 0
        if (this.pos < 7 && size > 0) {
          this.sizes[this.pos] = size - 1
          this.parts[this.pos] = (this.parts[this.pos] ?? 0) + (byte - 0x30) * 10 ** (size - 1)
          this.ignore = false
        }
        this.fresh = false
      } else if (
        byte === 0x3a &&
        !this.fresh &&
        !this.ignore &&
        (this.pos === 3 || this.pos === 4)
      ) {
        advance = true
      } else if (byte === 0x2b) {
        this.pos = 6
      } else if (byte === DASH) {
        this.plus = false
        this.pos = 6
      } else if (SPACE.has(byte) && !this.fresh && !this.ignore) {
        advance = true
      } else if (isAlpha(byte)) {
        if (this.pos === 1) {
          if (this.monthChars + 1 >= 1 && this.monthChars + 1 <= 3) {
            this.month += String.fromCharCode(byte).toLowerCase()
          }
          this.monthChars += 1
        }
        if (this.pos === 6) {
          this.zone(byte)
          advance = true
        }
        this.fresh = false
      } else if (byte === 0x28) {
        comments += 1
        this.fresh = true
        continue
      } else if (byte === 0x3b) {
        this.reset()
        continue
      }
      if (advance) {
        const size = this.sizes[this.pos] ?? 0
        if (this.pos < 7 && size > 0) {
          this.parts[this.pos] = Math.floor((this.parts[this.pos] ?? 0) / 10 ** size)
        }
        this.pos += 1
        this.fresh = true
      }
    }
    return this.finish()
  }

  finish(): MimeValue {
    if (this.pos < 6) return 'Empty'
    const month = this.monthChars === 3 ? (MONTHS[this.month] ?? 0) : (this.parts[1] ?? 0)
    if (month < 1 || month > 12) return 'Empty'
    let year = this.parts[2] ?? 0
    if (year >= 0 && year <= 49) year += 2000
    else if (year >= 50 && year <= 99) year += 1900
    return {
      DateTime: {
        year,
        month,
        day: this.parts[0] ?? 0,
        hour: this.parts[3] ?? 0,
        minute: this.parts[4] ?? 0,
        second: this.parts[5] ?? 0,
        tz_before_gmt: !this.plus,
        tz_hour: Math.floor((this.parts[6] ?? 0) / 100) % 24,
        tz_minute: ((this.parts[6] ?? 0) % 100) % 60,
      },
    }
  }
}

const NAME = 0
const ADDRESS = 1
const QUOTE = 2
const COMMENT = 3

interface MailAddress {
  name: string | null
  address: string | null
}

/** Mailbox lists and groups, with their comments and encoded words. */
class AddressParser {
  tokenStart = 0
  tokenEnd = 0
  isEmail = false
  tokenFresh = true
  escaped = false
  lastEncoded = true
  names: string[] = []
  mails: string[] = []
  comments: string[] = []
  state = NAME
  stack: number[] = []
  addresses: MailAddress[] = []
  groupName: string | null = null
  groupComment: string | null = null
  groups: { name: string | null; addresses: MailAddress[] }[] = []

  constructor(private readonly stream: Stream) {}

  addToken(): void {
    if (this.tokenStart === 0) return
    const token = text(this.stream.slice(this.tokenStart - 1, this.tokenEnd))
    let addSpace = false
    let target: string[]
    if (this.state === ADDRESS) {
      target = this.mails
    } else if (this.state === NAME) {
      if (this.isEmail) {
        target = this.mails
      } else {
        addSpace = true
        target = this.names
      }
    } else if (this.state === QUOTE) {
      target = this.names
    } else {
      addSpace = true
      target = this.comments
    }
    if (addSpace && target.length > 0) target.push(' ')
    target.push(token)
    this.tokenStart = 0
    this.isEmail = false
    this.tokenFresh = true
    this.escaped = false
    this.lastEncoded = false
  }

  addRfc2047(token: string): void {
    const addSpace = !this.lastEncoded && this.state !== QUOTE
    const target = this.state === COMMENT ? this.comments : this.names
    if (addSpace && target.length > 0) target.push(' ')
    target.push(token)
    this.lastEncoded = true
  }

  addAddress(): void {
    const name = this.names.join('')
    const mail = this.mails.join('')
    const comment = this.comments.join('')
    this.names = []
    this.mails = []
    this.comments = []
    const hasName = name !== ''
    const hasMail = mail !== ''
    const hasComment = comment !== ''
    let entry: MailAddress
    if (hasMail && hasName && hasComment) {
      entry = { name: `${name} (${comment})`, address: mail }
    } else if (hasName && hasMail) {
      entry = { name, address: mail }
    } else if (hasMail && hasComment) {
      entry = { name: comment, address: mail }
    } else if (hasMail) {
      entry = { name: null, address: mail }
    } else if (hasName && hasComment) {
      entry = /\s/.test(name)
        ? { name: `${name} (${comment})`, address: null }
        : { name: comment, address: name }
    } else if (hasName) {
      entry = { name, address: null }
    } else if (hasComment) {
      entry = { name: comment, address: null }
    } else {
      return
    }
    this.addresses.push(entry)
  }

  addGroupDetails(): void {
    if (this.names.length > 0) {
      this.groupName = this.names.join('')
      this.names = []
    }
    if (this.comments.length > 0) {
      this.groupComment = this.comments.join('')
      this.comments = []
    }
    if (this.mails.length > 0) {
      const mail = this.mails.join('')
      this.mails = []
      this.groupName = this.groupName !== null ? `${this.groupName} ${mail}` : mail
    }
  }

  addGroup(): void {
    const name = this.groupName
    const comment = this.groupComment
    let title: string | null
    if (name !== null && this.addresses.length > 0 && comment !== null) {
      title = `${name} (${comment})`
    } else if (this.addresses.length > 0 && name !== null) {
      title = name
    } else if (this.addresses.length > 0) {
      title = comment
    } else if (name !== null) {
      this.groups.push({ name, addresses: [] })
      this.groupName = null
      return
    } else {
      return
    }
    this.groups.push({ name: title, addresses: this.addresses })
    this.addresses = []
    this.groupName = null
    this.groupComment = null
  }

  run(): MimeValue {
    const stream = this.stream
    for (let byte = stream.next(); byte !== null; byte = stream.next()) {
      if (byte === NEWLINE) {
        this.addToken()
        if (this.state === QUOTE) {
          if (stream.peekNextIsSpace()) continue
          break
        }
        if (stream.tryNextIsSpace()) {
          this.tokenFresh = true
          continue
        }
        break
      }
      if (byte === 0x5c && this.state !== NAME && !this.escaped) {
        if (this.tokenStart > 0) {
          if (this.state === QUOTE) this.tokenEnd = stream.pos - 1
          this.addToken()
        }
        this.escaped = true
        continue
      }
      if (byte === 0x2c && this.state === NAME) {
        this.addToken()
        this.addAddress()
        continue
      }
      if (byte === 0x3c && this.state === NAME) {
        this.isEmail = false
        this.addToken()
        this.stack.push(NAME)
        this.state = ADDRESS
        continue
      }
      if (byte === 0x3e && this.state === ADDRESS) {
        this.addToken()
        this.state = this.stack.pop() ?? NAME
        continue
      }
      if (byte === 0x22 && !this.escaped) {
        if (this.state === NAME) {
          this.stack.push(NAME)
          this.state = QUOTE
          this.addToken()
          continue
        }
        if (this.state === QUOTE) {
          this.addToken()
          this.state = this.stack.pop() ?? NAME
          continue
        }
      } else if (byte === 0x40 && this.state === NAME) {
        this.isEmail = true
      } else if (byte === 0x3d && this.tokenFresh && !this.escaped && stream.peekChar(0x3f)) {
        stream.checkpoint()
        const token = stream.decodeRfc2047()
        if (token !== null) {
          this.addToken()
          this.addRfc2047(token)
          continue
        }
        stream.restore()
      } else if (SPACE.has(byte)) {
        this.tokenFresh = true
        this.escaped = false
        if (this.state === QUOTE) {
          if (this.tokenStart === 0) {
            this.tokenStart = stream.pos
            this.tokenEnd = this.tokenStart
          } else {
            this.tokenEnd = stream.pos
          }
        }
        continue
      } else if (byte === RETURN) {
        continue
      } else if (byte === 0x28 && this.state !== QUOTE && !this.escaped) {
        this.stack.push(this.state)
        if (this.state !== COMMENT) {
          this.addToken()
          this.state = COMMENT
          this.lastEncoded = false
          continue
        }
      } else if (byte === 0x29 && this.state === COMMENT && !this.escaped) {
        const restored = this.stack.pop() ?? NAME
        if (this.state !== restored) {
          this.addToken()
          this.state = restored
          this.lastEncoded = false
          continue
        }
      } else if (byte === 0x3a && this.state === NAME && !this.escaped) {
        this.addGroup()
        this.addToken()
        this.addGroupDetails()
        continue
      } else if (byte === 0x3b && this.state === NAME) {
        this.addToken()
        this.addAddress()
        this.addGroup()
        continue
      }
      this.escaped = false
      this.tokenFresh = false
      if (this.tokenStart === 0) {
        this.tokenStart = stream.pos
        this.tokenEnd = this.tokenStart
      } else {
        this.tokenEnd = stream.pos
      }
    }
    this.addAddress()
    if (this.groupName !== null || this.groups.length > 0) {
      this.addGroup()
      return { Address: { Group: this.groups } } as unknown as MimeValue
    }
    if (this.addresses.length > 0)
      return { Address: { List: this.addresses } } as unknown as MimeValue
    return 'Empty'
  }
}

const TYPE = 0
const SUBTYPE = 1
const ATTR_NAME = 2
const VALUE = 3
const QUOTED = 4
const COMMENTED = 5

interface Attribute {
  name: string
  value: string
}

function decodePercent(value: string): Uint8Array | null {
  const out: number[] = []
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index) & 0xff
    if (code === 0x25) {
      const high = value.charCodeAt(index + 1)
      const low = value.charCodeAt(index + 2)
      if (Number.isNaN(high) || Number.isNaN(low) || !isHex(high) || !isHex(low)) return null
      out.push(hexValue(high, low))
      index += 3
    } else {
      out.push(code)
      index += 1
    }
  }
  return concat(out)
}

/** A Content-Type or Content-Disposition with its parameters. */
class ContentTypeParser {
  state = TYPE
  stack: number[] = []
  cType: string | null = null
  cSubtype: string | null = null
  attrName: string | null = null
  attrCharset: string | null = null
  attrPosition = 0
  values: string[] = []
  attributes: Attribute[] = []
  continuations: [string, number, string][] = []
  tokenStart = 0
  tokenEnd = 0
  continuation = false
  encoded = false
  escaped = false
  removeCrlf = false
  fresh = true

  constructor(private readonly stream: Stream) {}

  reset(): void {
    this.tokenStart = 0
    this.fresh = true
  }

  span(): string {
    return text(this.stream.slice(this.tokenStart - 1, this.tokenEnd))
  }

  addAttribute(): boolean {
    if (this.tokenStart === 0) return false
    const value = this.span().toLowerCase()
    if (this.state === ATTR_NAME) this.attrName = value
    else if (this.state === TYPE) this.cType = value
    else this.cSubtype = value
    this.reset()
    return true
  }

  addParameter(): void {
    if (this.tokenStart === 0) return
    const part = this.span()
    if (this.attrCharset === null) {
      this.attrCharset = part
    } else {
      const name = `${this.attrName ?? 'unknown'}-language`
      if (this.attributes.every((one) => one.name !== name)) {
        this.attributes.push({ name, value: part })
      } else {
        this.values.push("'", part)
      }
    }
    this.reset()
  }

  addPartial(toCurrent: boolean): void {
    if (this.tokenStart === 0) return
    const quoted = this.state === QUOTED
    const stop = quoted && toCurrent ? this.stream.pos - 1 : this.tokenEnd
    this.values.push(text(this.stream.slice(this.tokenStart - 1, stop)))
    if (!quoted) this.values.push(' ')
    this.reset()
  }

  addValue(): void {
    if (this.attrName === null) return
    const hasValues = this.values.length > 0
    let value: string | null = null
    if (this.tokenStart > 0) {
      let raw = this.stream.slice(this.tokenStart - 1, this.tokenEnd)
      if (this.removeCrlf) {
        this.removeCrlf = false
        raw = raw.filter((byte) => byte !== RETURN && byte !== NEWLINE)
      }
      value = text(raw)
    } else if (!hasValues) {
      return
    }
    const name = this.attrName
    this.attrName = null
    if (!this.continuation) {
      let joined: string
      if (hasValues) {
        if (value !== null) this.values.push(value)
        joined = this.values.join('')
      } else {
        joined = value ?? ''
      }
      this.attributes.push({ name, value: joined })
    } else {
      let joined: string
      if (value !== null) joined = hasValues ? this.values.join('') + value : value
      else joined = this.values.join('')
      if (this.encoded) {
        const decoded = decodePercent(joined)
        if (decoded !== null) joined = decodeCharset(decoded, this.attrCharset)
        this.encoded = false
      }
      if (this.attrPosition > 0) {
        this.continuations.push([name, this.attrPosition, joined])
        this.attrPosition = 0
      } else {
        this.attributes.push({ name, value: joined })
      }
      this.continuation = false
      this.attrCharset = null
    }
    if (hasValues) this.values = []
    this.reset()
  }

  addPosition(): boolean {
    if (this.tokenStart === 0) return false
    const parsed = Number.parseInt(this.span(), 10)
    this.attrPosition = Number.isNaN(parsed) ? 0 : parsed
    this.reset()
    return true
  }

  merge(): void {
    const sorted = [...this.continuations].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1] - b[1],
    )
    for (const [name, , value] of sorted) {
      const existing = this.attributes.find((one) => one.name === name)
      if (existing !== undefined) existing.value = `${existing.value}${value}`
      else this.attributes.push({ name, value })
    }
  }

  finish(): MimeValue {
    if (this.continuations.length > 0) this.merge()
    if (this.cType === null) return 'Empty'
    return {
      ContentType: {
        c_type: this.cType,
        c_subtype: this.cSubtype,
        attributes: this.attributes.length > 0 ? this.attributes : null,
      },
    } as unknown as MimeValue
  }

  onNewline(): MimeValue | undefined {
    const stream = this.stream
    const nextSpace = stream.peekNextIsSpace()
    if (this.state === TYPE || this.state === ATTR_NAME || this.state === SUBTYPE) {
      this.addAttribute()
    } else if (this.state === VALUE) {
      this.addValue()
    } else if (this.state === QUOTED) {
      if (nextSpace) {
        stream.pos += 1
        this.removeCrlf = true
        return undefined
      }
      this.addValue()
    }
    if (nextSpace) {
      if (this.state === TYPE) return undefined
      this.state = ATTR_NAME
      stream.pos += 1
      this.fresh = true
      return undefined
    }
    return this.finish()
  }

  run(): MimeValue {
    const stream = this.stream
    for (let byte = stream.next(); byte !== null; byte = stream.next()) {
      if (SPACE.has(byte)) {
        this.fresh = true
        if (this.state === QUOTED) {
          if (this.tokenStart === 0) {
            this.tokenStart = stream.pos
            this.tokenEnd = this.tokenStart
          } else {
            this.tokenEnd = stream.pos
          }
        }
        continue
      }
      if (byte === NEWLINE) {
        const done = this.onNewline()
        if (done !== undefined) return done
        continue
      }
      if (byte === 0x2f && this.state === TYPE) {
        this.addAttribute()
        this.state = SUBTYPE
        continue
      }
      if (byte === 0x3b) {
        if (this.state === TYPE || this.state === SUBTYPE || this.state === ATTR_NAME) {
          this.addAttribute()
          this.state = ATTR_NAME
          continue
        }
        if (this.state === VALUE) {
          if (!this.escaped) {
            this.addValue()
            this.state = ATTR_NAME
          } else {
            this.escaped = false
          }
          continue
        }
      } else if (byte === 0x2a && this.state === ATTR_NAME) {
        if (!this.continuation) {
          this.continuation = this.addAttribute()
        } else if (!this.encoded) {
          this.addPosition()
          this.encoded = true
        } else {
          this.reset()
        }
        continue
      } else if (byte === 0x3d) {
        if (this.state === ATTR_NAME) {
          if (!this.continuation) {
            if (!this.addAttribute()) continue
          } else if (!this.encoded) {
            this.encoded = !this.addPosition()
          } else {
            this.reset()
          }
          this.state = VALUE
          continue
        }
        if (
          (this.state === VALUE || this.state === QUOTED) &&
          this.fresh &&
          stream.peekChar(0x3f)
        ) {
          stream.checkpoint()
          const token = stream.decodeRfc2047()
          if (token !== null) {
            this.addPartial(false)
            this.values.push(token)
            continue
          }
          stream.restore()
        }
      } else if (byte === 0x22) {
        if (this.state === VALUE) {
          this.fresh = true
          this.state = QUOTED
          continue
        }
        if (this.state === QUOTED) {
          if (!this.escaped) {
            this.addValue()
            this.state = ATTR_NAME
            continue
          }
          this.escaped = false
        } else {
          continue
        }
      } else if (byte === 0x5c) {
        if (this.state === QUOTED || this.state === VALUE) {
          if (!this.escaped) {
            this.addPartial(true)
            this.escaped = true
            continue
          }
          this.escaped = false
        } else if (this.state === COMMENTED) {
          this.escaped = !this.escaped
        } else {
          continue
        }
      } else if (
        byte === 0x27 &&
        this.encoded &&
        !this.escaped &&
        (this.state === VALUE || this.state === QUOTED)
      ) {
        this.addParameter()
        continue
      } else if (byte === 0x28 && this.state !== QUOTED) {
        if (!this.escaped) {
          if (this.state === TYPE || this.state === ATTR_NAME || this.state === SUBTYPE) {
            this.addAttribute()
          } else if (this.state === VALUE) {
            this.addValue()
          }
          this.stack.push(this.state)
          this.state = COMMENTED
        } else {
          this.escaped = false
        }
        continue
      } else if (byte === 0x29 && this.state === COMMENTED) {
        if (!this.escaped) {
          this.state = this.stack.pop() ?? TYPE
          this.reset()
        } else {
          this.escaped = false
        }
        continue
      } else if (byte === RETURN) {
        continue
      }
      this.escaped = false
      this.fresh = false
      if (this.tokenStart === 0) {
        this.tokenStart = stream.pos
        this.tokenEnd = this.tokenStart
      } else {
        this.tokenEnd = stream.pos
      }
    }
    return 'Empty'
  }
}

interface WalkState {
  kind: Kind
  boundary: Uint8Array | null
  inAlternative: boolean
  parts: number
  htmlParts: number
  textParts: number
  needHtml: boolean
  needText: boolean
  partId: number
  subParts: number[]
  offsetHeader: number
  offsetBody: number
  offsetEnd: number
}

function newState(overrides: Partial<WalkState> = {}): WalkState {
  return {
    kind: Kind.MESSAGE,
    boundary: null,
    inAlternative: false,
    parts: 0,
    htmlParts: 0,
    textParts: 0,
    needHtml: true,
    needText: true,
    partId: 0,
    subParts: [],
    offsetHeader: 0,
    offsetBody: 0,
    offsetEnd: 0,
    ...overrides,
  }
}

/** A parsed message: its part list and the body indexes into it. */
export class MimeMessage {
  htmlBody: number[] = []
  textBody: number[] = []
  attachments: number[] = []
  parts: MimePart[] = []
  /** An attached message keeps its own bytes here. */
  raw: Uint8Array = new Uint8Array(0)

  isEmpty(): boolean {
    return this.parts.length === 0
  }

  asDocument(): Record<string, JsonValue> {
    return {
      html_body: this.htmlBody,
      text_body: this.textBody,
      attachments: this.attachments,
      parts: this.parts.map(partDocument),
    }
  }
}

function partDocument(part: MimePart): JsonValue {
  const body = part.body
  const rendered: JsonValue =
    'Message' in body ? { Message: body.Message.asDocument() } : (body as unknown as JsonValue)
  return {
    headers: part.headers as unknown as JsonValue,
    is_encoding_problem: part.is_encoding_problem,
    body: rendered,
    offset_header: part.offset_header,
    offset_body: part.offset_body,
    offset_end: part.offset_end,
  }
}

/** The part at this position, which the walk has just built. */
export function partAt(message: MimeMessage, id: number): MimePart {
  const part = message.parts[id]
  if (part === undefined) throw new Error(`mime: no part ${String(id)}`)
  return part
}

function popState(stack: [WalkState, MimeMessage | null][]): [WalkState, MimeMessage | null] {
  const top = stack.pop()
  if (top === undefined) throw new Error('mime: empty part stack')
  return top
}

/** The value of a part's first header of this name, null when absent. */
export function headerValue(headers: MimeHeader[], name: string): MimeValue {
  return headers.find((header) => header.name === name)?.value ?? null
}

export interface ContentFields {
  c_type: string
  c_subtype: string | null
  attributes: Attribute[] | null
}

/** A Content-Type-shaped header's fields. */
export function contentTypeOf(headers: MimeHeader[], name: string): ContentFields | null {
  const value = headerValue(headers, name)
  if (value !== null && typeof value === 'object' && 'ContentType' in value) {
    return (value as unknown as { ContentType: ContentFields }).ContentType
  }
  return null
}

/** A parameter of a Content-Type-shaped value. */
export function attributeOf(content: ContentFields | null, name: string): string | null {
  if (content === null) return null
  return content.attributes?.find((attribute) => attribute.name === name)?.value ?? null
}

function mimeKind(
  content: ContentFields | null,
  parent: Kind,
): { multipart: boolean; inline: boolean; isText: boolean; kind: Kind } {
  if (content === null) {
    if (parent === Kind.DIGEST) {
      return { multipart: false, inline: false, isText: false, kind: Kind.MESSAGE }
    }
    return { multipart: false, inline: true, isText: true, kind: Kind.PLAIN }
  }
  const subtype = content.c_subtype
  if (content.c_type === 'multipart') {
    const kinds: Record<string, Kind> = {
      mixed: Kind.MIXED,
      alternative: Kind.ALTERNATIVE,
      related: Kind.RELATED,
      digest: Kind.DIGEST,
    }
    return {
      multipart: true,
      inline: false,
      isText: false,
      kind: subtype === null ? Kind.OTHER : (kinds[subtype] ?? Kind.OTHER),
    }
  }
  if (content.c_type === 'text') {
    if (subtype === 'plain')
      return { multipart: false, inline: true, isText: true, kind: Kind.PLAIN }
    if (subtype === 'html') return { multipart: false, inline: true, isText: true, kind: Kind.HTML }
    return { multipart: false, inline: false, isText: true, kind: Kind.TEXT_OTHER }
  }
  if (content.c_type === 'image' || content.c_type === 'audio' || content.c_type === 'video') {
    return { multipart: false, inline: true, isText: false, kind: Kind.INLINE }
  }
  if (content.c_type === 'message' && (subtype === 'rfc822' || subtype === 'global')) {
    return { multipart: false, inline: false, isText: false, kind: Kind.MESSAGE }
  }
  return { multipart: false, inline: false, isText: false, kind: Kind.OTHER }
}

/**
 * Parse a message into its part list. Part positions are the ids
 * `message read` and `attachment` print, so the walk visits a multipart
 * container before its children and counts an attached message as a
 * part of its own.
 */
export function parseMime(raw: Uint8Array, depth: number = MAX_NESTED): MimeMessage | null {
  const stream = new Stream(raw)
  let message = new MimeMessage()
  let state = newState()
  const stack: [WalkState, MimeMessage | null][] = []
  let headers: MimeHeader[] = []
  for (;;) {
    state.offsetHeader = stream.pos
    if (!stream.parseHeaders(headers)) break
    state.offsetBody = stream.pos
    state.parts += 1
    state.subParts.push(message.parts.length)
    const content = contentTypeOf(headers, 'content_type')
    const shape = mimeKind(content, state.kind)
    let { inline, isText, kind } = shape
    const boundaryText = attributeOf(content, 'boundary')
    if (shape.multipart && boundaryText !== null) {
      const boundary = ENC.encode(boundaryText)
      if (stream.seekNextPart(boundary)) {
        const nextState = newState({
          inAlternative: state.inAlternative || kind === Kind.ALTERNATIVE,
          kind,
          boundary,
          htmlParts: message.htmlBody.length,
          textParts: message.textBody.length,
          needHtml: state.needHtml,
          needText: state.needText,
          partId: message.parts.length,
        })
        message.parts.push({
          headers,
          is_encoding_problem: false,
          body: { Text: '' },
          offset_header: state.offsetHeader,
          offset_body: state.offsetBody,
          offset_end: 0,
        })
        headers = []
        stack.push([state, null])
        state = nextState
        stream.skipCrlf()
        continue
      }
      kind = Kind.TEXT_OTHER
      isText = true
    }
    const encoding = headerValue(headers, 'content_transfer_encoding')
    const method =
      encoding !== null &&
      typeof encoding === 'object' &&
      typeof (encoding as { Text?: unknown }).Text === 'string'
        ? (encoding as { Text: string }).Text.toLowerCase()
        : ''
    const boundaryBytes = state.boundary ?? ANONYMOUS_BOUNDARY
    if (kind === Kind.MESSAGE && method !== 'base64' && method !== 'quoted-printable') {
      const nextState = newState({
        kind: Kind.MESSAGE,
        boundary: state.boundary,
        partId: message.parts.length,
      })
      state.boundary = null
      message.attachments.push(message.parts.length)
      message.parts.push({
        headers,
        is_encoding_problem: false,
        body: { Text: '' },
        offset_header: state.offsetHeader,
        offset_body: state.offsetBody,
        offset_end: 0,
      })
      headers = []
      stack.push([state, message])
      message = new MimeMessage()
      state = nextState
      continue
    }
    let offsetEnd: number
    let data: Uint8Array
    if (method === 'base64') [offsetEnd, data] = stream.decodeBase64(boundaryBytes)
    else if (method === 'quoted-printable') {
      ;[offsetEnd, data] = stream.decodeQuotedPrintable(boundaryBytes)
    } else [offsetEnd, data] = stream.mimePart(boundaryBytes)
    const problem = offsetEnd === ENCODING_PROBLEM
    if (problem) {
      if (kind !== Kind.PLAIN) kind = Kind.TEXT_OTHER
      inline = false
      isText = true
      const [end, found] = stream.seekPartEnd(state.boundary)
      state.offsetEnd = end
      data = stream.slice(state.offsetBody, state.offsetEnd)
      if (!found) state.boundary = null
    } else {
      state.offsetEnd = offsetEnd
    }
    const built = partBody(
      message,
      state,
      headers,
      content,
      kind,
      inline,
      isText,
      problem,
      data,
      depth,
    )
    message.parts.push({
      headers,
      is_encoding_problem: problem || built.problem,
      body: built.body,
      offset_header: state.offsetHeader,
      offset_body: state.offsetBody,
      offset_end: state.offsetEnd,
    })
    headers = []
    if (state.boundary !== null) {
      const step = closeParts(stream, state, stack, message, raw)
      state = step.state
      message = step.message
      if (step.done) break
    } else if (stream.pos >= stream.data.length) {
      break
    }
  }
  return finish(stream, state, stack, message, headers, raw)
}

function partBody(
  message: MimeMessage,
  state: WalkState,
  headers: MimeHeader[],
  content: ContentFields | null,
  kind: Kind,
  inline: boolean,
  isText: boolean,
  problem: boolean,
  data: Uint8Array,
  depth: number,
): { body: MimeBody; problem: boolean } {
  const index = message.parts.length
  if (kind === Kind.MESSAGE) {
    message.attachments.push(index)
    const nested = depth !== 0 ? parseMime(data, depth - 1) : null
    if (nested !== null) {
      nested.raw = data
      return { body: { Message: nested }, problem: false }
    }
    return { body: { Binary: [...data] }, problem: true }
  }
  const disposition = contentTypeOf(headers, 'content_disposition')
  let isInline =
    inline &&
    !(disposition !== null && disposition.c_type === 'attachment') &&
    (state.parts === 1 ||
      (state.kind !== Kind.RELATED &&
        (kind === Kind.INLINE || content === null || attributeOf(content, 'name') === null)))
  isInline =
    isInline || (state.parts === 1 && state.kind === Kind.MESSAGE && kind === Kind.PLAIN && problem)
  let addHtml: boolean
  let addText: boolean
  if (state.kind === Kind.ALTERNATIVE) {
    addHtml = kind === Kind.HTML
    addText = kind === Kind.PLAIN
  } else if (isInline) {
    if (state.inAlternative && (state.needText || state.needHtml)) {
      if (kind === Kind.HTML) state.needText = false
      else if (kind === Kind.PLAIN) state.needHtml = false
    }
    addHtml = state.needHtml
    addText = state.needText
  } else {
    addHtml = false
    addText = false
  }
  if (addHtml) message.htmlBody.push(index)
  if (addText) message.textBody.push(index)
  if (isText) {
    const decoded = decodeCharset(data, attributeOf(content, 'charset'))
    const isHtml = kind === Kind.HTML
    if ((!addHtml && isHtml) || (!addText && !isHtml)) message.attachments.push(index)
    return { body: isHtml ? { Html: decoded } : { Text: decoded }, problem: false }
  }
  message.attachments.push(index)
  return {
    body: isInline ? { InlineBinary: [...data] } : { Binary: [...data] },
    problem: false,
  }
}

function closeParts(
  stream: Stream,
  state: WalkState,
  stack: [WalkState, MimeMessage | null][],
  message: MimeMessage,
  raw: Uint8Array,
): { state: WalkState; message: MimeMessage; done: boolean } {
  for (;;) {
    if (state.kind === Kind.MESSAGE) {
      const [previous, parent] = popState(stack)
      if (parent === null) throw new Error('mime: no parent message')
      let position: number
      if (state.boundary !== null) {
        position = Math.max(stream.pos - state.boundary.length - 2, 0)
        if (position >= 2 && stream.data[position - 2] === RETURN) position -= 2
        else position -= 1
      } else {
        position = stream.pos
      }
      const part = partAt(parent, state.partId)
      part.offset_end = position
      if (message.isEmpty()) {
        part.is_encoding_problem = true
        part.body = { Text: text(raw.subarray(part.offset_body, position)) }
      } else {
        message.raw = raw.subarray(part.offset_body, position)
        part.body = { Message: message }
      }
      message = parent
      previous.boundary = state.boundary
      state = previous
    }
    if (!stream.isMultipartEnd()) return { state, message, done: false }
    if (state.kind === Kind.ALTERNATIVE && state.needHtml && state.needText) {
      shareAlternative(message, state)
    }
    const part = partAt(message, state.partId)
    if (state.subParts.length !== 1 || state.subParts[0] !== 0) {
      part.body = { Multipart: state.subParts }
    }
    if (stack.length === 0) {
      part.offset_end = stream.pos
      return { state, message, done: true }
    }
    state = popState(stack)[0]
    if (state.boundary !== null) {
      const offset = stream.seekNextPartOffset(state.boundary)
      if (offset !== null) {
        part.offset_end = offset
        continue
      }
    }
    part.offset_end = stream.pos
    return { state, message, done: true }
  }
}

function shareAlternative(message: MimeMessage, state: WalkState): void {
  if (state.textParts === message.textBody.length && state.htmlParts !== message.htmlBody.length) {
    message.textBody.push(...message.htmlBody.slice(state.htmlParts))
  }
  if (state.htmlParts === message.htmlBody.length && state.textParts !== message.textBody.length) {
    message.htmlBody.push(...message.textBody.slice(state.textParts))
  }
}

function finish(
  stream: Stream,
  state: WalkState,
  stack: [WalkState, MimeMessage | null][],
  message: MimeMessage,
  headers: MimeHeader[],
  raw: Uint8Array,
): MimeMessage | null {
  while (stack.length > 0) {
    const [previous, parent] = popState(stack)
    if (parent !== null) {
      const part = partAt(parent, state.partId)
      part.offset_end = stream.pos
      if (message.isEmpty()) {
        part.is_encoding_problem = true
        part.body = { Text: text(raw.subarray(part.offset_body, stream.pos)) }
      } else {
        message.raw = raw.subarray(part.offset_body, stream.pos)
        part.body = { Message: message }
      }
      message = parent
    } else {
      const part = partAt(message, state.partId)
      part.offset_end = stream.pos
      if (state.subParts.length !== 1 || state.subParts[0] !== 0) {
        part.body = { Multipart: state.subParts }
      }
    }
    state = previous
  }
  if (!message.isEmpty()) {
    partAt(message, 0).offset_end = raw.length
    return message
  }
  if (headers.length > 0) {
    message.parts.push({
      headers,
      is_encoding_problem: true,
      body: { Text: '' },
      offset_header: 0,
      offset_body: raw.length,
      offset_end: raw.length,
    })
    return message
  }
  return null
}
