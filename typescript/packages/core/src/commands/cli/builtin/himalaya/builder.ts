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

import type { FlagView } from '../../../spec/index.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { materialize } from '../../../../io/types.ts'
import { Stream } from '../../../../core/email/mime.ts'
import type { fetchMessage } from '../../../../core/email/client.ts'

type SourceMode = 'reply' | 'forward'
export type PostingStyle = 'top' | 'bottom' | 'none'
const PREFIXES: Record<SourceMode, string> = { reply: 'Re: ', forward: 'Fwd: ' }
const FOLD_TARGET = 78
const MAX_LINE_LEN = 77
const MAX_CONTENT_LEN = 75
const MAX_ENCODED_WORD = 75
const ENCODED_LINE_TARGET = 76
const BASE64_LINE = 76
const SIGNATURE_DELIM = '-- \n'
const MESSAGE_ID_HOST = 'localhost'
const CONTENT_TYPE_COLUMN = 14
const CRLF = '\r\n'
const ENC = new TextEncoder()
const INLINE_ESCAPES = new Set(ENC.encode('=\r\t\n?'))
const ATTR_CHARS = new Set(
  ENC.encode('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$&+-.^_`|~'),
)
const Q_PLAIN = new Set(
  ENC.encode('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!*+-/'),
)

export interface Attachment {
  filename: string
  contentType: string
  data: Uint8Array
}

export interface Compose {
  sender: string
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  subject: string | null
  body: string
  signature: string | null
  attachments: readonly Attachment[]
}

export interface Source {
  message: Awaited<ReturnType<typeof fetchMessage>>
  mode: SourceMode
  postingStyle: PostingStyle
  quoteHeadline: string
}

type Mailbox = [string | null, string]

interface MailAddress {
  name: string | null
  address: string | null
}

/** Split an address value into its mailboxes. */
export function parseMailboxes(value: string): Mailbox[] {
  const parsed = new Stream(ENC.encode(`${value}\n`)).parseAddress()
  let entries: MailAddress[] = []
  if (parsed !== null && typeof parsed === 'object' && 'Address' in parsed) {
    const address = (
      parsed as unknown as {
        Address: { List?: MailAddress[]; Group?: { addresses: MailAddress[] }[] }
      }
    ).Address
    entries = address.List ?? (address.Group ?? []).flatMap((group) => group.addresses)
  }
  if (entries.length === 0) throw new Error(`Could not parse address \`${value}\``)
  return entries.map((entry): Mailbox => {
    if (entry.address === null) throw new Error(`Address \`${value}\` has no email`)
    return [entry.name, entry.address]
  })
}

function addressesOf(values: readonly string[]): Mailbox[] {
  return values.flatMap(parseMailboxes)
}

/**
 * Whether a subject already carries a Re:/Fwd: prefix. The colon is part
 * of the comparison: matching on the letters alone would read "Ready to
 * ship" as already prefixed with "Re:".
 */
export function hasPrefix(subject: string, prefix: string): boolean {
  const head = subject.trimStart()
  const marker = prefix.trim()
  return head.slice(0, marker.length).toLowerCase() === marker.toLowerCase()
}

function replyRecipients(message: Source['message']): Mailbox[] {
  const replyTo = message.reply_to ?? []
  const entries = replyTo.length > 0 ? replyTo : message.from !== undefined ? [message.from] : []
  return entries
    .filter((entry) => entry.email !== '')
    .map((entry): Mailbox => [entry.name === '' ? null : entry.name, entry.email])
}

/** Lay out the written text, the quoted source and the signature. */
export function composeBody(
  userBody: string,
  sourceText: string,
  headline: string,
  signature: string,
  style: PostingStyle,
): string {
  const written = userBody.replace(/\n+$/, '')
  const trimmed = sourceText.trim()
  const quoteLines: string[] = []
  if (trimmed !== '') {
    if (headline !== '') quoteLines.push(headline.replace(/\n+$/, ''))
    for (const line of trimmed.split(/\r?\n/)) {
      quoteLines.push(line.startsWith('>') ? `>${line}` : `> ${line}`)
    }
  }
  const quote = quoteLines.join('\n')
  let body: string
  if (style === 'none' || quote === '') body = written
  else if (written === '') body = quote
  else if (style === 'bottom') body = `${quote}\n\n${written}`
  else body = `${written}\n\n${quote}`
  if (signature.trim() !== '') {
    body += `\n\n${SIGNATURE_DELIM}${signature.replace(/\n+$/, '')}`
  }
  return body
}

function base64Length(size: number): number {
  return (Math.floor((size * 4) / 3) + 3) & ~3
}

function inlineEncoding(data: Uint8Array): 'none' | 'q' | 'b' {
  const high = data.some((byte) => byte >= 127)
  let escapes = data.filter((byte) => byte >= 127 || INLINE_ESCAPES.has(byte)).length
  let needs = high || data.length > MAX_LINE_LEN
  const last = data[data.length - 1]
  if (last === 0x20 || last === 0x09) {
    needs = true
    if (last === 0x20) escapes += 1
  }
  if (!needs) return 'none'
  return data.length + 2 * escapes < base64Length(data.length) ? 'q' : 'b'
}

function hexPair(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0')
}

function qWordAtoms(text: string, phrase: boolean, column: number = 0): string[] {
  const ascii = [...text].every((char) => char.charCodeAt(0) < 0x80)
  const head = `=?${ascii ? 'us-ascii' : 'utf-8'}?Q?`
  const tail = '?='
  let limit = Math.min(ENCODED_LINE_TARGET - column, MAX_ENCODED_WORD)
  const words: string[] = []
  let current = ''
  for (const char of text) {
    let piece = ''
    for (const byte of ENC.encode(char)) {
      if (byte === 0x20) piece += '_'
      else if (phrase && Q_PLAIN.has(byte)) piece += String.fromCharCode(byte)
      else if (
        !phrase &&
        byte >= 33 &&
        byte < 127 &&
        byte !== 0x3d &&
        byte !== 0x3f &&
        byte !== 0x5f
      ) {
        piece += String.fromCharCode(byte)
      } else piece += `=${hexPair(byte)}`
    }
    if (head.length + current.length + piece.length + tail.length > limit) {
      words.push(`${head}${current}${tail}`)
      current = ''
      limit = MAX_ENCODED_WORD
    }
    current += piece
  }
  words.push(`${head}${current}${tail}`)
  return words
}

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function bWordAtoms(text: string, column: number = 0): string[] {
  const head = '=?utf-8?B?'
  const tail = '?='
  const budget = Math.min(ENCODED_LINE_TARGET - column, MAX_ENCODED_WORD)
  let limit = Math.floor((budget - head.length - tail.length) / 4) * 3
  const words: string[] = []
  let current: number[] = []
  for (const char of text) {
    const piece = [...ENC.encode(char)]
    if (current.length + piece.length > limit) {
      words.push(`${head}${bytesToBase64(Uint8Array.from(current))}${tail}`)
      current = []
      limit = Math.floor((MAX_ENCODED_WORD - head.length - tail.length) / 4) * 3
    }
    current.push(...piece)
  }
  words.push(`${head}${bytesToBase64(Uint8Array.from(current))}${tail}`)
  return words
}

function phraseAtoms(name: string): string[] {
  const data = ENC.encode(name)
  const kind = inlineEncoding(data)
  if (kind === 'b') return bWordAtoms(name)
  if (kind === 'q') return qWordAtoms(name, true)
  return [`"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]
}

function folded(start: number, atoms: readonly string[]): string {
  let out = ''
  let column = start
  atoms.forEach((atom, index) => {
    if (index === 0) {
      out += atom
      column += atom.length
    } else if (column + 1 + atom.length > FOLD_TARGET && column > 1) {
      out += `${CRLF} ${atom}`
      column = 1 + atom.length
    } else {
      out += ` ${atom}`
      column += 1 + atom.length
    }
  })
  return out
}

function addressHeader(name: string, mailboxes: readonly Mailbox[]): string {
  const atoms: string[] = []
  const last = mailboxes.length - 1
  mailboxes.forEach(([display, email], index) => {
    if (display !== null && display !== '') atoms.push(...phraseAtoms(display))
    atoms.push(`<${email}>${index !== last ? ',' : ''}`)
  })
  return `${name}: ${folded(name.length + 2, atoms)}${CRLF}`
}

/** Words of an unstructured value; a line break never survives in one. */
function unstructured(text: string): string[] {
  const words: string[] = []
  let current = ''
  for (let index = 0; index < text.length;) {
    const char = text[index]!
    if (char === '\r' || char === '\n') {
      while (index < text.length && ' \t\r\n'.includes(text[index]!)) index += 1
      words.push(current)
      current = ''
      continue
    }
    current += char
    index += 1
  }
  words.push(current)
  return words.join(' ').split(' ')
}

function textHeader(name: string, text: string): string {
  const column = name.length + 2
  const kind = inlineEncoding(ENC.encode(text))
  const atoms =
    kind === 'b'
      ? bWordAtoms(text, column)
      : kind === 'q'
        ? qWordAtoms(text, false, column)
        : unstructured(text)
  return `${name}: ${folded(column, atoms)}${CRLF}`
}

function bodyScan(data: Uint8Array, isBody: boolean): { encoding: string; bareFeed: boolean } {
  let qpLength = Math.floor(data.length / 76) + data.length
  let needs = false
  let high = false
  let bareFeed = false
  let lineStart = 0
  data.forEach((byte, at) => {
    if (byte >= 127) {
      high = true
      qpLength += 2
    } else if (byte === 0x3d || (!isBody && byte === 0x0d)) {
      qpLength += 2
    } else if (byte === 0x0a) {
      if (at + 1 - lineStart > MAX_LINE_LEN) needs = true
      lineStart = at + 1
      const afterCr = at > 0 && data[at - 1] === 0x0d
      bareFeed = bareFeed || !afterCr
      if (isBody) {
        if (!afterCr) qpLength += 1
        const white = afterCr ? at - 2 : at - 1
        if (white >= 0 && (data[white] === 0x20 || data[white] === 0x09)) {
          qpLength += 2
          needs = true
        }
      } else {
        qpLength += 2
        if (!afterCr) needs = true
      }
    }
  })
  needs = needs || high
  const last = data[data.length - 1]
  if (last === 0x20 || last === 0x09) {
    qpLength += 2
    needs = true
  }
  if (data.length - lineStart > MAX_LINE_LEN) needs = true
  if (!needs) return { encoding: '7bit', bareFeed }
  return {
    encoding: qpLength < base64Length(data.length) ? 'quoted-printable' : 'base64',
    bareFeed,
  }
}

function quotedPrintable(data: Uint8Array, isBody: boolean): number[] {
  const out: number[] = []
  let column = 0
  const plain = (chunk: readonly number[]): void => {
    let rest = chunk
    while (column + rest.length > MAX_CONTENT_LEN) {
      const room = Math.max(MAX_CONTENT_LEN - column, 0)
      out.push(...rest.slice(0, room), 0x3d, 0x0d, 0x0a)
      column = 0
      rest = rest.slice(room)
    }
    out.push(...rest)
    column += rest.length
  }
  const escape = (byte: number): void => {
    if (column + 3 > MAX_CONTENT_LEN) {
      out.push(...ENC.encode(`=\r\n=${hexPair(byte)}`))
      column = 3
    } else {
      out.push(...ENC.encode(`=${hexPair(byte)}`))
      column += 3
    }
  }
  const run = (chunk: readonly number[]): void => {
    let start = 0
    chunk.forEach((byte, index) => {
      if (
        (isBody && (byte === 0x20 || byte === 0x09)) ||
        (byte >= 33 && byte < 127 && byte !== 0x3d)
      )
        return
      if (!isBody && byte === 0x20) return
      plain(chunk.slice(start, index))
      escape(byte)
      start = index + 1
    })
    plain(chunk.slice(start))
  }
  const bytes = [...data]
  if (!isBody) {
    const last = bytes[bytes.length - 1]
    const trailing = last === 0x20 || last === 0x09
    run(trailing ? bytes.slice(0, -1) : bytes)
    if (trailing) escape(last)
    return out
  }
  const lines: number[][] = [[]]
  for (const byte of bytes) {
    if (byte === 0x0a) lines.push([])
    else lines[lines.length - 1]!.push(byte)
  }
  lines.forEach((source, index) => {
    const isLast = index === lines.length - 1
    let line = source
    if (!isLast && line[line.length - 1] === 0x0d) line = line.slice(0, -1)
    const end = line[line.length - 1]
    if (end === 0x20 || end === 0x09) {
      run(line.slice(0, -1))
      escape(end)
    } else {
      run(line)
    }
    if (!isLast) {
      out.push(0x0d, 0x0a)
      column = 0
    }
  })
  return out
}

function base64Wrapped(data: Uint8Array): number[] {
  const encoded = bytesToBase64(data)
  const out: number[] = []
  for (let at = 0; at < encoded.length; at += BASE64_LINE) {
    out.push(...ENC.encode(`${encoded.slice(at, at + BASE64_LINE)}\r\n`))
  }
  return out
}

function crlfNormalized(data: Uint8Array): number[] {
  const out: number[] = []
  data.forEach((byte, index) => {
    if (byte === 0x0a && (index === 0 || data[index - 1] !== 0x0d)) out.push(0x0d)
    out.push(byte)
  })
  return out
}

function encodedText(data: Uint8Array, isBody: boolean): number[] {
  const { encoding, bareFeed } = bodyScan(data, isBody)
  const head = [...ENC.encode(`Content-Transfer-Encoding: ${encoding}\r\n\r\n`)]
  if (encoding === 'base64') return [...head, ...base64Wrapped(data)]
  if (encoding === 'quoted-printable') return [...head, ...quotedPrintable(data, isBody)]
  return [...head, ...(isBody && bareFeed ? crlfNormalized(data) : data)]
}

function randomHex(): string {
  const words = new Uint32Array(2)
  globalThis.crypto.getRandomValues(words)
  return `${words[0]!.toString(16)}${words[1]!.toString(16).padStart(8, '0')}`
}

function boundary(separator: string): string {
  return [randomHex(), randomHex(), randomHex()].join(separator)
}

function textPart(body: string): number[] {
  return [
    ...ENC.encode('Content-Type: text/plain; charset="utf-8"\r\n'),
    ...encodedText(ENC.encode(body), true),
  ]
}

/**
 * A `key=value` header parameter, encoded when it has to be. Anything
 * outside printable ASCII is written the RFC 2231 way, which leaves no
 * way for a value to end the header line.
 */
function parameter(key: string, value: string): string {
  const data = ENC.encode(value)
  if (data.some((byte) => byte < 0x20 || byte >= 0x7f)) {
    let encoded = ''
    for (const byte of data) {
      encoded += ATTR_CHARS.has(byte) ? String.fromCharCode(byte) : `%${hexPair(byte)}`
    }
    return `${key}*=utf-8''${encoded}`
  }
  return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function attachmentPart(attachment: Attachment): number[] {
  const head = [
    ...ENC.encode(
      `Content-Type: ${attachment.contentType}\r\nContent-Disposition: attachment; ${parameter('filename', attachment.filename)}\r\n`,
    ),
  ]
  if (attachment.contentType.split('/')[0] === 'text') {
    return [...head, ...encodedText(attachment.data, false)]
  }
  return [
    ...head,
    ...ENC.encode('Content-Transfer-Encoding: base64\r\n\r\n'),
    ...base64Wrapped(attachment.data),
  ]
}

function bodyBytes(body: string, attachments: readonly Attachment[]): number[] {
  if (attachments.length === 0) return textPart(body)
  const mark = boundary('_')
  const parameter = `boundary="${mark}"`
  const gap = CONTENT_TYPE_COLUMN + 15 + 2 + parameter.length > FOLD_TARGET ? `;${CRLF} ` : '; '
  const out = [...ENC.encode(`Content-Type: multipart/mixed${gap}${parameter}${CRLF}${CRLF}`)]
  for (const part of [textPart(body), ...attachments.map(attachmentPart)]) {
    out.push(...ENC.encode(`\r\n--${mark}\r\n`), ...part)
  }
  out.push(...ENC.encode(`\r\n--${mark}--\r\n`))
  return out
}

function bareId(messageId: string): string {
  let id = messageId.trim()
  if (id.startsWith('<')) id = id.slice(1)
  if (id.endsWith('>')) id = id.slice(0, -1)
  return id.trim()
}

function rfc822Now(): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const now = new Date()
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mm = String(now.getUTCMinutes()).padStart(2, '0')
  const ss = String(now.getUTCSeconds()).padStart(2, '0')
  return (
    `${days[now.getUTCDay()]!}, ${String(now.getUTCDate())} ${months[now.getUTCMonth()]!} ` +
    `${String(now.getUTCFullYear())} ${hh}:${mm}:${ss} +0000`
  )
}

/** Assemble an RFC 5322 message from flags and an optional source. */
export function build(compose: Compose, source: Source | null = null): Uint8Array {
  const head: string[] = []
  const [name, email] = parseMailboxes(compose.sender)[0]!
  head.push(addressHeader('From', [[name, email]]))
  if (compose.to.length > 0) head.push(addressHeader('To', addressesOf(compose.to)))
  if (compose.cc.length > 0) head.push(addressHeader('Cc', addressesOf(compose.cc)))
  if (compose.bcc.length > 0) head.push(addressHeader('Bcc', addressesOf(compose.bcc)))
  let subject = compose.subject
  let sourceText = ''
  let style: PostingStyle = 'top'
  let headline = ''
  if (source !== null) {
    const original = source.message
    const prefix = PREFIXES[source.mode]
    if (subject === null) {
      subject = hasPrefix(original.subject, prefix)
        ? original.subject
        : `${prefix}${original.subject}`
    }
    if (source.mode === 'reply' && compose.to.length === 0) {
      const recipients = replyRecipients(original)
      if (recipients.length > 0) head.push(addressHeader('To', recipients))
    }
    const messageId = original.message_id
    if (messageId !== '') {
      if (source.mode === 'reply') head.push(`In-Reply-To: <${bareId(messageId)}>${CRLF}`)
      const chain = [...(original.references ?? []), messageId]
      const references = chain
        .filter((one) => bareId(one) !== '')
        .map((one) => `<${bareId(one)}>`)
        .join(' ')
      head.push(`References: ${references}${CRLF}`)
    }
    sourceText = original.body_text
    style = source.postingStyle
    headline = source.quoteHeadline
  }
  if (subject !== null) head.push(textHeader('Subject', subject))
  const body = composeBody(compose.body, sourceText, headline, compose.signature ?? '', style)
  head.push(
    `Message-ID: <${boundary('.')}@${MESSAGE_ID_HOST}>${CRLF}Date: ${rfc822Now()}${CRLF}MIME-Version: 1.0${CRLF}`,
  )
  return Uint8Array.from([...ENC.encode(head.join('')), ...bodyBytes(body, compose.attachments)])
}

/** Resolve the body from --body, --body-file, then piped stdin. */
export async function readBody(
  fl: FlagView,
  stdin: ByteSource | null,
  fileText: string | null,
): Promise<string> {
  const inline = fl.asStr('body')
  if (inline !== undefined) return inline
  if (fileText !== null) return fileText
  if (stdin === null) return ''
  return new TextDecoder().decode(await materialize(stdin))
}
