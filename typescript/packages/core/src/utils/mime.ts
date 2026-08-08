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

import { encodeBase64 } from './base64.ts'

// A byte-exact port of the corners of python's email package that the
// himalaya builder rides: RFC 2047 encoded words with the q/b length
// chooser, the unstructured-header refolder, mailbox display-name
// encoding, RFC 2231 mime-parameter folding, and the content manager's
// 7bit/8bit/quoted-printable/base64 body selection. Python is the
// reference implementation (EmailMessage + policy.SMTP); every rule
// here is pinned against it in integ/fixtures/himalaya/mime_parity.json
// rather than against the RFCs, because the two builders must agree to
// the byte.

const MAXLEN = 78
const EW_CHROME = 'utf-8'.length + 7
const ENC = new TextEncoder()

/** A latin-1 view of raw bytes, for the quoted-printable scanner. */
function latin1(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return out
}

/** True when every character is 7-bit ASCII. */
function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x00-\x7f]/.test(value)
}

const Q_SAFE = new Set<number>()
for (const c of '-!*+/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
  Q_SAFE.add(c.charCodeAt(0))
}

function hex2(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0')
}

function encodeQ(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    if (byte === 0x20) out += '_'
    else if (Q_SAFE.has(byte)) out += String.fromCharCode(byte)
    else out += `=${hex2(byte)}`
  }
  return out
}

function lenQ(bytes: Uint8Array): number {
  let total = 0
  for (const byte of bytes) total += byte === 0x20 || Q_SAFE.has(byte) ? 1 : 3
  return total
}

function lenB(bytes: Uint8Array): number {
  const groups = Math.floor(bytes.length / 3)
  return groups * 4 + (bytes.length % 3 === 0 ? 0 : 4)
}

/**
 * One RFC 2047 encoded word, choosing the shorter transfer encoding
 * with python's bias: q wins unless b is at least five characters
 * shorter (email._encoded_words.encode).
 */
function encodeWord(text: string): string {
  const bytes = ENC.encode(text)
  const encoding = lenQ(bytes) - lenB(bytes) < 5 ? 'q' : 'b'
  const encoded = encoding === 'q' ? encodeQ(bytes) : encodeBase64(bytes)
  return `=?utf-8?${encoding}?${encoded}?=`
}

interface Token {
  text: string
  fws: boolean
}

/**
 * Split into runs of linear whitespace and everything else. A phrase
 * (an address display name) also splits at dots, which the address
 * grammar lexes as their own terminals, so a dot stays plain next to
 * an encoded word ('J. =?utf-8?q?B=C3=B6b?=').
 */
function tokenize(value: string, phrase: boolean): Token[] {
  const tokens: Token[] = []
  const splitter = phrase ? /([ \t]+|\.)/ : /([ \t]+)/
  for (const piece of value.split(splitter)) {
    if (piece === '') continue
    tokens.push({ text: piece, fws: piece.startsWith(' ') || piece.startsWith('\t') })
  }
  return tokens
}

function stealTrailingWsp(lines: string[]): string {
  const last = lines[lines.length - 1] ?? ''
  const tail = last.slice(-1)
  if (tail !== ' ' && tail !== '\t') return ''
  lines[lines.length - 1] = last.slice(0, -1)
  return tail
}

/** Append to the last line in place; folding always has one. */
function appendLast(lines: string[], text: string): void {
  lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + text
}

interface FoldState {
  lastEw: number | null
  /** The decoded text lines[-1] holds from lastEw on, for EW merging. */
  spanPlain: string
  leadingWs: string
}

/**
 * email._header_value_parser._fold_as_ew: write to_encode as encoded
 * words, merging with the encoded span already on the line and
 * splitting into per-line chunks that fit.
 */
function foldAsEw(toEncode: string, lines: string[], maxlen: number, state: FoldState): void {
  if (state.lastEw !== null) {
    toEncode = state.spanPlain + toEncode
    lines[lines.length - 1] = (lines[lines.length - 1] ?? '').slice(0, state.lastEw)
  } else if (toEncode.startsWith(' ') || toEncode.startsWith('\t')) {
    const leadingWsp = toEncode[0] ?? ''
    toEncode = toEncode.slice(1)
    if ((lines[lines.length - 1] ?? '').length === maxlen) {
      lines.push(stealTrailingWsp(lines))
    }
    appendLast(lines, leadingWsp)
  }
  let trailingWsp = ''
  const tail = toEncode.slice(-1)
  if (tail === ' ' || tail === '\t') {
    trailingWsp = tail
    toEncode = toEncode.slice(0, -1)
  }
  let newLastEw = state.lastEw ?? (lines[lines.length - 1] ?? '').length
  let leadingWs = state.leadingWs
  // The decoded text of encoded words already written to the line the
  // final chunk lands on: a folded whitespace run gets written as its
  // own encoded word (RFC 2047 drops the plain whitespace between two
  // encoded words), and a later merge has to see it.
  let spanPrefix = ''
  let lastChunk = ''
  // Code points, not UTF-16 units: CPython slices str by code point,
  // so the chunk budgets must count the same way.
  let rest = Array.from(toEncode)
  while (rest.length > 0) {
    const remainingSpace = maxlen - (lines[lines.length - 1] ?? '').length
    const textSpace = remainingSpace - EW_CHROME - leadingWs.length
    if (textSpace <= 0) {
      lines.push(' ')
      continue
    }
    if (lines.length > 1 && (lines[lines.length - 1] ?? '').length === 1 && leadingWs !== '') {
      appendLast(lines, encodeWord(leadingWs))
      spanPrefix = leadingWs
      leadingWs = ''
    }
    let word = rest.slice(0, textSpace)
    let encodedWord = encodeWord(word.join(''))
    while (encodedWord.length - remainingSpace > 0) {
      word = word.slice(0, -1)
      encodedWord = encodeWord(word.join(''))
    }
    appendLast(lines, encodedWord)
    rest = rest.slice(word.length)
    leadingWs = ''
    lastChunk = word.join('')
    if (rest.length > 0) {
      lines.push(' ')
      newLastEw = 1
      spanPrefix = ''
    }
  }
  appendLast(lines, trailingWsp)
  state.lastEw = newLastEw
  state.spanPlain = spanPrefix + lastChunk + trailingWsp
  state.leadingWs = ''
}

/**
 * email._header_value_parser._refold_parse_tree over the terminals of
 * an unstructured value: plain runs pack greedily, folds happen at
 * whitespace, and any run that carries non-ASCII (or a newline, or is
 * too long to fold plainly) becomes an encoded word.
 */
function foldTokens(lines: string[], value: string, maxlen: number, phrase = false): void {
  const state: FoldState = { lastEw: null, spanPlain: '', leadingWs: '' }
  const queue = tokenize(value, phrase)
  while (queue.length > 0) {
    const token = queue.shift()
    if (token === undefined) break
    const tstr = token.text
    const wantEncoding = !isAscii(tstr) || /[\r\n]/.test(tstr)
    if (wantEncoding) {
      foldAsEw(tstr, lines, maxlen, state)
      continue
    }
    if ((lines[lines.length - 1] ?? '').length + tstr.length <= maxlen) {
      appendLast(lines, tstr)
      if (state.lastEw !== null) state.spanPlain += tstr
      continue
    }
    state.leadingWs = ''
    if (tstr.length + 1 <= maxlen) {
      const newline = stealTrailingWsp(lines)
      if (newline !== '' || token.fws) {
        lines.push(newline + tstr)
        const match = /^[ \t]*/.exec(lines[lines.length - 1] ?? '')
        state.leadingWs = match === null ? '' : match[0]
        state.lastEw = null
        state.spanPlain = ''
        continue
      }
    }
    // Too long to fold as plain text: encode it just to wrap it, which
    // is what python does with an over-long word.
    foldAsEw(tstr, lines, maxlen, state)
  }
}

// The line boundaries python's str.splitlines recognizes, which is the
// set EmailMessage's header guard checks against.
// eslint-disable-next-line no-control-regex
const HEADER_LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\u0085\u2028\u2029]/

/**
 * Refuse a header value EmailMessage would refuse (header injection).
 *
 * Python's check is str.splitlines-based: a value is refused when it
 * spans more than one line, so a single trailing terminator passes (and
 * serializes inside an encoded word).
 */
export function assertHeaderValue(value: string): void {
  const lines = value.split(HEADER_LINE_BREAKS)
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length > 1) {
    throw new Error('Header values may not contain linefeed or carriage return characters')
  }
}

/**
 * Fold one unstructured header (Subject, References, In-Reply-To) the
 * way EmailMessage.as_bytes(policy=SMTP) does, continuation lines and
 * encoded words included. Returns the header with embedded CRLFs and
 * no trailing linesep. An empty value renders as `Name:` with no
 * trailing blank, matching python's empty parse tree.
 */
export function foldUnstructured(name: string, value: string): string {
  const lines = [`${name}:`]
  if (value === '') return lines.join('\r\n')
  appendLast(lines, ' ')
  if (isAscii(value) && !/[\r\n]/.test(value)) {
    if ((lines[lines.length - 1] ?? '').length + value.length <= MAXLEN) {
      appendLast(lines, value)
      return lines.join('\r\n')
    }
    if (value.length + 1 <= MAXLEN) {
      const newline = stealTrailingWsp(lines)
      if (newline !== '' || value.startsWith(' ') || value.startsWith('\t')) {
        lines.push(newline + value)
        return lines.join('\r\n')
      }
    }
  }
  foldTokens(lines, value, MAXLEN)
  return lines.join('\r\n')
}

/**
 * One mailbox as python's address folder renders it when it fits on a
 * line: ASCII passes through untouched, and a non-ASCII display name
 * becomes encoded words while the angle-addr and the whitespace run
 * before it stay plain.
 *
 * The input domain is what the CLI can produce: comma-free (the flag
 * splitter cuts on commas first) and trimmed. A display name that
 * python's address grammar would tear apart - an unquoted comma from a
 * parsed source header, say - is malformed on both sides and is not
 * chased to the byte.
 */
function renderMailbox(raw: string): string {
  const value = raw.trim()
  if (isAscii(value)) return value
  const lt = value.lastIndexOf('<')
  if (lt <= 0) return value
  const rest = value.slice(lt)
  if (!isAscii(rest)) return value
  const beforeAngle = value.slice(0, lt)
  const gap = /[ \t]*$/.exec(beforeAngle)?.[0] ?? ''
  let name = beforeAngle.slice(0, beforeAngle.length - gap.length)
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\([\s\S])/g, '$1')
  }
  const lines = ['']
  foldTokens(lines, name, Number.POSITIVE_INFINITY, true)
  return `${lines.join('')}${gap}${rest}`
}

/**
 * Fold an address header the way python's AddressList folder does:
 * the whole rendered list stays on the label's line when it fits,
 * moves to one continuation line when it fits a line by itself, and
 * otherwise breaks after commas - the comma stays on the prior line
 * and the next mailbox starts a continuation line behind one space.
 */
export function foldAddressList(name: string, mailboxes: readonly string[]): string {
  const rendered = mailboxes.map((mailbox) => renderMailbox(mailbox))
  const whole = rendered.join(', ')
  if (`${name}: `.length + whole.length <= MAXLEN) return `${name}: ${whole}`
  if (whole.length <= MAXLEN) return `${name}:\r\n ${whole}`
  const lines = [`${name}:`]
  for (let i = 0; i < rendered.length; i += 1) {
    const piece = rendered[i] ?? ''
    if ((lines[lines.length - 1] ?? '').length + 1 + piece.length <= MAXLEN) {
      appendLast(lines, ` ${piece}`)
    } else if (1 + piece.length <= MAXLEN) {
      lines.push(` ${piece}`)
    } else {
      // A single mailbox longer than a line overflows in place, which
      // is python's give-up branch too.
      appendLast(lines, ` ${piece}`)
    }
    if (i < rendered.length - 1) appendLast(lines, ',')
  }
  return lines.join('\r\n')
}

function quoteString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

const PCT_SAFE = new Set<number>()
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-~') {
  PCT_SAFE.add(c.charCodeAt(0))
}

function pctQuote(value: string): string {
  let out = ''
  for (const byte of ENC.encode(value)) {
    out += PCT_SAFE.has(byte) ? String.fromCharCode(byte) : `%${hex2(byte)}`
  }
  return out
}

// The line-break characters python's str.splitlines recognizes within
// ASCII; the wider set (NEL, LS, PS) is non-ASCII and so can only reach
// the RFC 2231 path, which percent-encodes it harmlessly.
// eslint-disable-next-line no-control-regex
const ASCII_LINE_BREAKS = /[\n\r\v\f\x1c\x1d\x1e]/

/**
 * The attachment Content-Disposition header with its filename folded
 * as python's _fold_mime_parameters does: quoted when ASCII and short,
 * RFC 2231 `filename*=utf-8''…` when non-ASCII, and split into
 * numbered `filename*N*=` sections when too long for one line.
 *
 * An ASCII filename holding any line break is refused outright the way
 * EmailMessage refuses it (header injection through the quoted-string
 * form) - trailing terminators included, unlike the header-value guard.
 */
export function foldContentDisposition(filename: string): string {
  const ascii = isAscii(filename)
  if (ascii && ASCII_LINE_BREAKS.test(filename)) {
    throw new Error('Header values may not contain linefeed or carriage return characters')
  }
  const lines = ['Content-Disposition: attachment']
  if (!(lines[lines.length - 1] ?? '').trimEnd().endsWith(';')) appendLast(lines, ';')
  const tstr = ascii
    ? `filename=${quoteString(filename)}`
    : `filename*=utf-8''${pctQuote(filename)}`
  if ((lines[lines.length - 1] ?? '').length + tstr.length + 1 < MAXLEN) {
    appendLast(lines, ` ${tstr}`)
    return lines.join('\r\n')
  }
  if (tstr.length + 2 <= MAXLEN) {
    lines.push(` ${tstr}`)
    return lines.join('\r\n')
  }
  let section = 0
  let extraChrome = ascii ? "us-ascii''" : "utf-8''"
  // Code points, matching CPython's str slicing.
  let rest = Array.from(filename)
  while (rest.length > 0) {
    const chromeLen = 'filename'.length + String(section).length + 3 + extraChrome.length
    const maxlen = MAXLEN <= chromeLen + 3 ? 78 : MAXLEN
    const maxchars = maxlen - chromeLen - 2
    let splitpoint = maxchars
    let encoded = pctQuote(rest.slice(0, splitpoint).join(''))
    while (encoded.length > maxchars) {
      splitpoint -= 1
      encoded = pctQuote(rest.slice(0, splitpoint).join(''))
    }
    lines.push(` filename*${String(section)}*=${extraChrome}${encoded}`)
    extraChrome = ''
    section += 1
    rest = rest.slice(splitpoint)
    if (rest.length > 0) appendLast(lines, ';')
  }
  return lines.join('\r\n')
}

const QP_BODY_SAFE = new Set<number>()
for (const c of ' !"#$%&\'()*+,-./0123456789:;<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\t') {
  QP_BODY_SAFE.add(c.charCodeAt(0))
}

/**
 * email.quoprimime.body_encode over a latin-1 view of the bytes, with
 * python 3.12's soft-break placement and trailing-whitespace quoting.
 */
function qpBodyEncode(body: string, maxlinelen = MAXLEN, eol = '\n'): string {
  if (body === '') return body
  let translated = ''
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i)
    if (code === 0x0d || code === 0x0a || QP_BODY_SAFE.has(code)) translated += body[i] ?? ''
    else translated += `=${hex2(code)}`
  }
  const softBreak = `=${eol}`
  const maxlinelen1 = maxlinelen - 1
  const encoded: string[] = []
  // str.splitlines drops the final empty piece a trailing terminator
  // leaves behind in a plain split.
  const bodyLines = translated.split(/\r\n|\r|\n/)
  if (bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
  for (const line of bodyLines) {
    let start = 0
    const laststart = line.length - 1 - maxlinelen
    while (start <= laststart) {
      const stop = start + maxlinelen1
      if (line[stop - 2] === '=') {
        encoded.push(line.slice(start, stop - 1))
        start = stop - 2
      } else if (line[stop - 1] === '=') {
        encoded.push(line.slice(start, stop))
        start = stop - 1
      } else {
        encoded.push(`${line.slice(start, stop)}=`)
        start = stop
      }
    }
    const tail = line.slice(-1)
    if (line !== '' && (tail === ' ' || tail === '\t')) {
      const room = start - laststart
      let quoted = ''
      if (room >= 3) quoted = `=${hex2(line.charCodeAt(line.length - 1))}`
      else if (room === 2) quoted = tail + softBreak
      else quoted = softBreak + `=${hex2(line.charCodeAt(line.length - 1))}`
      encoded.push(line.slice(start, -1) + quoted)
    } else {
      encoded.push(line.slice(start))
    }
  }
  const last = translated.slice(-1)
  if (last === '\r' || last === '\n') encoded.push('')
  return encoded.join(eol)
}

/** contentmanager._encode_base64: 57 input bytes per 76-char line. */
export function encodeBase64Lines(data: Uint8Array): string {
  const perLine = Math.floor(MAXLEN / 4) * 3
  let out = ''
  for (let i = 0; i < data.length; i += perLine) {
    out += `${encodeBase64(data.subarray(i, i + perLine))}\n`
  }
  return out
}

/** A body's transfer encoding and its encoded payload. */
export interface EncodedText {
  cte: '7bit' | '8bit' | 'quoted-printable' | 'base64'
  /** LF-separated and LF-terminated; the caller normalizes to CRLF. */
  payload: string
}

/**
 * email.contentmanager._encode_text with cte unset under the default
 * policy (max_line_length 78, cte_type 8bit, linesep LF): short lines
 * stay 7bit/8bit, anything longer sniffs the first ten lines to pick
 * quoted-printable or base64.
 */
export function encodeText(body: string): EncodedText {
  // bytes.splitlines: \r, \n and \r\n only (unlike str.splitlines, no
  // \v/\f/\x1c-\x1e), and no phantom empty line after a trailing
  // terminator.
  const lines = body.split(/\r\n|[\n\r]/)
  if (lines[lines.length - 1] === '') lines.pop()
  const maxLine = lines.reduce((max, line) => Math.max(max, ENC.encode(line).length), 0)
  const normal = lines.length === 0 ? '\n' : `${lines.join('\n')}\n`
  if (maxLine <= MAXLEN) {
    if (isAscii(normal)) return { cte: '7bit', payload: normal }
    return { cte: '8bit', payload: normal }
  }
  const sniffLines = lines.slice(0, 10)
  const sniff = `${sniffLines.join('\n')}\n`
  const sniffBytes = ENC.encode(sniff)
  const sniffQp = qpBodyEncode(latin1(sniffBytes), MAXLEN)
  const sniffBase64Len = lenB(sniffBytes) + 1
  if (sniffQp.length > sniffBase64Len) {
    return { cte: 'base64', payload: encodeBase64Lines(ENC.encode(normal)) }
  }
  if (lines.length <= 10) return { cte: 'quoted-printable', payload: sniffQp }
  const normalBytes = ENC.encode(normal)
  return { cte: 'quoted-printable', payload: qpBodyEncode(latin1(normalBytes), MAXLEN) }
}
