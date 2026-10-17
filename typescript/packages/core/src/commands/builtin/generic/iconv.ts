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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { PathSpec } from '../../../types.ts'
import { strverscmp } from '../../../utils/strverscmp.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { neverOpened, stdinStream } from '../utils/stream.ts'
import {
  CUT,
  ILLEGAL,
  MULTIBYTE_CHARSETS,
  MultibyteEncoder,
  hostDecoder,
  multibyteTable,
  type Decoded,
  type MultibyteSpec,
} from './iconv_multibyte.ts'

const HINT = "Try `iconv --help' or `iconv --usage' for more information."
const INCOMPLETE = 'incomplete character or shift sequence at end of buffer'
const ILLEGAL_AT = 'illegal input sequence at position '
const NAME_TRAIL = ' \t\n\v\f\r,/'
const NAME_DROPS = /[^0-9A-Za-z_.,:/-]/g

type HandCharset =
  | 'utf-8'
  | 'utf-16'
  | 'utf-16le'
  | 'utf-16be'
  | 'ucs-2le'
  | 'ucs-2be'
  | 'latin1'
  | 'ascii'

type Charset = HandCharset | MultibyteSpec

// glibc's names for the charsets both hosts convert by hand, upper-cased.
// glibc reads a typed name without regard to case, and drops every character
// but letters, digits and _-.,: before it does, so "utf 8" is UTF8 while
// LATIN-1 and UTF_8 are refused. Mirrors Python's CHARSETS.
export const CHARSETS: Readonly<Record<string, HandCharset>> = {
  'UTF-8': 'utf-8',
  UTF8: 'utf-8',
  'UTF-16': 'utf-16',
  UTF16: 'utf-16',
  'UTF-16LE': 'utf-16le',
  UTF16LE: 'utf-16le',
  'UTF-16BE': 'utf-16be',
  UTF16BE: 'utf-16be',
  'UCS-2': 'ucs-2le',
  UCS2: 'ucs-2le',
  'UCS-2LE': 'ucs-2le',
  'UCS-2BE': 'ucs-2be',
  'ISO-8859-1': 'latin1',
  'ISO8859-1': 'latin1',
  ISO88591: 'latin1',
  'ISO_8859-1': 'latin1',
  'ISO_8859-1:1987': 'latin1',
  'ISO-IR-100': 'latin1',
  LATIN1: 'latin1',
  L1: 'latin1',
  CP819: 'latin1',
  IBM819: 'latin1',
  CSISOLATIN1: 'latin1',
  ASCII: 'ascii',
  'US-ASCII': 'ascii',
  'ANSI_X3.4-1968': 'ascii',
  'ANSI_X3.4-1986': 'ascii',
  'ISO646-US': 'ascii',
  'ISO_646.IRV:1991': 'ascii',
  US: 'ascii',
  CP367: 'ascii',
  IBM367: 'ascii',
  CSASCII: 'ascii',
}

/**
 * The name glibc looks a typed charset up by, null when it has none.
 *
 * glibc drops the blanks, commas and slashes that end a name, then every
 * character but an ASCII letter, a digit, `_-.,:` and `/`, and reads the rest
 * without regard to case and with a final slash dropped: `s(jis)//` and
 * `SJIS/!` are SJIS, while `S_JIS`, `/SJIS` and `ſjis` (a long s) are not. A
 * name with nothing left is the default charset. A second slash starts a
 * suffix, and glibc's `//TRANSLIT` and `//IGNORE` are not supported.
 */
function charsetKey(name: string): string | null {
  let end = name.length
  while (end > 0 && NAME_TRAIL.includes(name.charAt(end - 1))) end -= 1
  const code = name.slice(0, end)
  if (code.indexOf('/') !== code.lastIndexOf('/')) return null
  const key = code.replace(NAME_DROPS, '').toUpperCase().replace(/\/$/, '')
  return key.includes('/') ? null : key || 'UTF-8'
}

/**
 * The charset an iconv name selects, null when there is none.
 *
 * A hand-written charset is its name in `CHARSETS` and a multi-byte one its
 * `MultibyteSpec`, unless the platform's `TextDecoder` cannot seed its table.
 */
function charsetOf(name: string): Charset | null {
  const key = charsetKey(name)
  if (key === null) return null
  const hand = CHARSETS[key]
  if (hand !== undefined) return hand
  const multibyte = MULTIBYTE_CHARSETS[key]
  return multibyte !== undefined && hostDecoder(multibyte) !== null ? multibyte : null
}

/**
 * What `iconv -l` prints: one name per line, as glibc does to a pipe. glibc
 * lists every name with the `//` that ends an empty suffix, in `strverscmp`
 * order; mirage lists only the charsets this host converts.
 */
export function listText(): Uint8Array {
  const names = [...Object.keys(CHARSETS), ...Object.keys(MULTIBYTE_CHARSETS)]
    .filter((name) => charsetOf(name) !== null)
    .map((name) => `${name}//`)
    .sort(strverscmp)
  return encodeText(names.map((name) => `${name}\n`).join(''))
}

function unsupported(fromEnc: string, toEnc: string, fromOk: boolean, toOk: boolean): Uint8Array {
  let line: string
  if (!fromOk && !toOk) {
    line = `iconv: conversions from \`${fromEnc}' and to \`${toEnc}' are not supported`
  } else if (!fromOk) {
    line = `iconv: conversion from \`${fromEnc}' is not supported`
  } else {
    line = `iconv: conversion to \`${toEnc}' is not supported`
  }
  return encodeText(`${line}\n${HINT}\n`)
}

/** The bytes a refused sequence spans, so `-c` skips it whole. */
function unitOf(charset: HandCharset): number {
  return charset.startsWith('utf-16') || charset.startsWith('ucs-2') ? 2 : 1
}

function utf8Second(lead: number): [number, number] {
  if (lead === 0xe0) return [0xa0, 0xbf]
  if (lead === 0xed) return [0x80, 0x9f]
  if (lead === 0xf0) return [0x90, 0xbf]
  if (lead === 0xf4) return [0x80, 0x8f]
  return [0x80, 0xbf]
}

function decodeUtf8(raw: Uint8Array, at: number): Decoded {
  const lead = raw[at] ?? 0
  if (lead < 0x80) return [lead, 1]
  let length: number
  let cp: number
  if (lead >= 0xc2 && lead <= 0xdf) {
    length = 2
    cp = lead & 0x1f
  } else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3
    cp = lead & 0x0f
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4
    cp = lead & 0x07
  } else {
    return [ILLEGAL, 0]
  }
  for (let i = 1; i < length; i++) {
    if (at + i >= raw.length) return [CUT, 0]
    const byte = raw[at + i] ?? 0
    const [low, high] = i === 1 ? utf8Second(lead) : [0x80, 0xbf]
    if (byte < low || byte > high) return [ILLEGAL, 0]
    cp = (cp << 6) | (byte & 0x3f)
  }
  return [cp, length]
}

/** A UTF-16 unit, or a pair; UCS-2 (`pairs` false) refuses every surrogate. */
function decodeUtf16(raw: Uint8Array, at: number, little: boolean, pairs: boolean): Decoded {
  const unit = (offset: number): number => {
    const a = raw[offset] ?? 0
    const b = raw[offset + 1] ?? 0
    return little ? a | (b << 8) : (a << 8) | b
  }
  if (at + 2 > raw.length) return [CUT, 0]
  const first = unit(at)
  if ((first >= 0xdc00 && first <= 0xdfff) || (first >= 0xd800 && first <= 0xdbff && !pairs)) {
    return [ILLEGAL, 0]
  }
  if (first < 0xd800 || first > 0xdbff) return [first, 2]
  if (at + 4 > raw.length) return [CUT, 0]
  const second = unit(at + 2)
  if (second < 0xdc00 || second > 0xdfff) return [ILLEGAL, 0]
  return [0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00), 4]
}

/**
 * One character of a hand-written charset: (code point, bytes used).
 *
 * The code point is `ILLEGAL` for a sequence the charset does not allow,
 * with the bytes `-c` skips, and `CUT` for one the input ends inside of.
 * Mirrors the Python `_decode_at`.
 */
function decodeAt(raw: Uint8Array, at: number, charset: HandCharset, little: boolean): Decoded {
  const byte = raw[at] ?? 0
  if (charset === 'latin1') return [byte, 1]
  let decoded: Decoded
  if (charset === 'ascii') decoded = byte < 0x80 ? [byte, 1] : [ILLEGAL, 0]
  else if (charset === 'utf-8') decoded = decodeUtf8(raw, at)
  else decoded = decodeUtf16(raw, at, little, charset.startsWith('utf-16'))
  return decoded[0] === ILLEGAL ? [ILLEGAL, unitOf(charset)] : decoded
}

/**
 * The target side of a hand-written charset, shared by every input so a UTF-16
 * BOM is written once, before the first character. `put` writes one character
 * at `at` and returns the next offset, or -1 when the charset cannot hold it.
 * Mirrors Python's `_HandEncoder`.
 */
class HandEncoder {
  private bom: boolean

  constructor(private readonly charset: HandCharset) {
    this.bom = charset === 'utf-16'
  }

  put(cp: number, out: Uint8Array, at: number): number {
    let n = at
    if (this.charset === 'ascii' || this.charset === 'latin1') {
      if (cp >= (this.charset === 'ascii' ? 0x80 : 0x100)) return -1
      out[n] = cp
      return n + 1
    }
    if (this.charset === 'utf-8') {
      if (cp < 0x80) {
        out[n++] = cp
      } else if (cp < 0x800) {
        out[n++] = 0xc0 | (cp >> 6)
        out[n++] = 0x80 | (cp & 0x3f)
      } else if (cp < 0x10000) {
        out[n++] = 0xe0 | (cp >> 12)
        out[n++] = 0x80 | ((cp >> 6) & 0x3f)
        out[n++] = 0x80 | (cp & 0x3f)
      } else {
        out[n++] = 0xf0 | (cp >> 18)
        out[n++] = 0x80 | ((cp >> 12) & 0x3f)
        out[n++] = 0x80 | ((cp >> 6) & 0x3f)
        out[n++] = 0x80 | (cp & 0x3f)
      }
      return n
    }
    if (this.charset.startsWith('ucs-2') && cp > 0xffff) return -1
    if (this.bom) {
      this.bom = false
      out[n++] = 0xff
      out[n++] = 0xfe
    }
    const little = !this.charset.endsWith('be')
    const units = cp < 0x10000 ? [cp] : [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + (cp & 0x3ff)]
    for (const u of units) {
      out[n++] = little ? u & 0xff : u >> 8
      out[n++] = little ? u >> 8 : u & 0xff
    }
    return n
  }
}

type Encoder = HandEncoder | MultibyteEncoder

interface Converted {
  data: Uint8Array
  dropped: boolean
  error: string | null
}

interface IconvFlags {
  readonly fromEnc: string
  readonly toEnc: string
  readonly ignoreErrors: boolean
  readonly outputPath: PathSpec | null
  readonly listCharsets: boolean
}

function parseFlags(bag: Record<string, FlagValue>): IconvFlags {
  const fl = new FlagView(bag, specOf('iconv'))
  return {
    fromEnc: fl.asNonEmpty('f', 'utf-8'),
    toEnc: fl.asNonEmpty('t', 'utf-8'),
    ignoreErrors: fl.asBool('c'),
    outputPath: fl.asPath('o') ?? null,
    listCharsets: fl.asBool('list'),
  }
}

/**
 * Convert each input from one charset to another, in order. Follows glibc's
 * iconv: -c drops what cannot be converted and exits 1; without it the output
 * stops before the first such sequence and no later input is read. An input
 * that cannot be opened is reported and skipped; one that opens and then
 * refuses the read, a directory, ends the run. Deliberate divergence: with no
 * -f or -t the charset is UTF-8, where GNU takes the locale's (ASCII under
 * LC_ALL=C). Mirrors Python's `iconv`, which also converts the other charsets
 * Python's codecs know; this host refuses them.
 */
export async function iconvGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags)
  if (parsed.listCharsets) return [listText(), new IOResult()]
  const fromName = parsed.fromEnc
  const toName = parsed.toEnc
  const fromCharset = charsetOf(fromName)
  const toCharset = charsetOf(toName)
  if (fromCharset === null || toCharset === null) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: unsupported(fromName, toName, fromCharset !== null, toCharset !== null),
      }),
    ]
  }
  const encoder: Encoder =
    typeof toCharset === 'string' ? new HandEncoder(toCharset) : new MultibyteEncoder(toCharset)
  const operands =
    paths.length > 0
      ? paths.map((path) => ({ path, source: stream(path) }))
      : [{ path: null, source: ctx.stdin ?? new Uint8Array() }]
  const io = new IOResult()
  const inputCharset = fromCharset
  const report = async (line: string): Promise<void> => {
    io.exitCode = 1
    io.stderr = concat([await materialize(io.stderr), encodeText(`iconv: ${line}\n`)])
  }
  async function* output(): AsyncIterable<Uint8Array> {
    for (const { path, source } of operands) {
      const reader = new AsyncLineIterator(source)
      try {
        for await (const result of convertStream(
          reader,
          inputCharset,
          encoder,
          parsed.ignoreErrors,
        )) {
          if (result.dropped) io.exitCode = 1
          if (result.error !== null) await report(result.error)
          if (result.data.length > 0) yield result.data
          if (result.error !== null) return
        }
      } catch (err) {
        if (!isFsError(err)) throw err
        const code = (err as { code?: string }).code
        const strerror = String(fsStrerror(err))
        if (
          path === null ||
          (code !== undefined && READ_FAILURES.has(code)) ||
          !neverOpened(reader, path, err)
        ) {
          await report(`error while reading the input: ${strerror}`)
          break
        }
        await report(`cannot open input file \`${path.rawPath}': ${strerror}`)
      }
    }
  }
  const converted = output()
  if (parsed.outputPath !== null) {
    const spool = new ByteSpool()
    try {
      await spool.fill(converted)
      await write(parsed.outputPath, spool.stream())
    } finally {
      await spool.close()
    }
    return [null, io]
  }
  return [converted, io]
}

async function* convertStream(
  reader: AsyncLineIterator,
  charset: Charset,
  encoder: Encoder,
  omit: boolean,
): AsyncIterable<Converted> {
  let pending: Uint8Array = new Uint8Array()
  let offset = 0
  let little = typeof charset !== 'string' || !charset.endsWith('be')
  let first = true
  const table = typeof charset === 'string' ? new Map<number, number>() : multibyteTable(charset)
  try {
    for (let part = await reader.readChunk(); part !== null; part = await reader.readChunk()) {
      const raw = pending.length > 0 ? concat([pending, part]) : part
      let at = 0
      if (first && charset === 'utf-16') {
        if (raw.length < 2) {
          pending = raw
          continue
        }
        if (raw[0] === 0xff && raw[1] === 0xfe) at = 2
        else if (raw[0] === 0xfe && raw[1] === 0xff) {
          at = 2
          little = false
        }
      }
      first = false
      const out = new Uint8Array(raw.length * 4 + 2)
      let n = 0
      let dropped = false
      while (at < raw.length) {
        const [cp, length] =
          typeof charset === 'string'
            ? decodeAt(raw, at, charset, little)
            : charset.step(raw, at, table)
        if (cp === CUT) break
        const next = cp === ILLEGAL ? -1 : encoder.put(cp, out, n)
        if (next < 0) {
          if (!omit) {
            yield {
              data: out.subarray(0, n),
              dropped,
              error: ILLEGAL_AT + String(offset + at),
            }
            return
          }
          dropped = true
        } else n = next
        at += length
      }
      pending = raw.slice(at)
      offset += at
      yield { data: out.subarray(0, n), dropped, error: null }
    }
  } finally {
    await reader.discard()
  }
  if (pending.length > 0) yield { data: new Uint8Array(), dropped: false, error: INCOMPLETE }
}
