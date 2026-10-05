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
import { mountKey } from '../../../utils/key_prefix.ts'
import { READ_FAILURES, fsStrerror, isFsError } from '../../../utils/errors.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { concat } from '../../../io/cachable_iterator.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync, stdinStream } from '../utils/stream.ts'

const ENC = new TextEncoder()

const HINT = "Try `iconv --help' or `iconv --usage' for more information."
const INCOMPLETE = 'incomplete character or shift sequence at end of buffer'

type Charset =
  | 'utf-8'
  | 'utf-16'
  | 'utf-16le'
  | 'utf-16be'
  | 'ucs-2le'
  | 'ucs-2be'
  | 'latin1'
  | 'ascii'

// glibc's names for the charsets this host converts, upper-cased: glibc
// matches a name without regard to case but not to punctuation, so LATIN-1
// and UTF_8 are refused while ISO88591 and UCS2 are not. Mirrors Python's
// CHARSETS; //TRANSLIT and //IGNORE are not supported.
export const CHARSETS: Readonly<Record<string, Charset>> = {
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

function charsetOf(name: string): Charset | null {
  return CHARSETS[name.toUpperCase()] ?? null
}

function unsupported(fromEnc: string, toEnc: string, fromOk: boolean): Uint8Array {
  let line: string
  if (!fromOk && charsetOf(toEnc) === null) {
    line = `iconv: conversions from \`${fromEnc}' and to \`${toEnc}' are not supported`
  } else if (!fromOk) {
    line = `iconv: conversion from \`${fromEnc}' is not supported`
  } else {
    line = `iconv: conversion to \`${toEnc}' is not supported`
  }
  return ENC.encode(`${line}\n${HINT}\n`)
}

// The bytes a refused sequence spans, so -c skips a UTF-16 or UCS-2 unit
// whole. Mirrors Python's `_unit`.
function unitOf(charset: Charset): number {
  return charset.startsWith('utf-16') || charset.startsWith('ucs-2') ? 2 : 1
}

// One decoded character, or why the bytes at `start` are not one: `illegal`
// is a sequence the charset does not allow, `incomplete` one the input ends
// inside of.
type Decoded =
  | { kind: 'char'; cp: number; length: number }
  | { kind: 'illegal' }
  | { kind: 'incomplete' }

function utf8Second(lead: number): [number, number] {
  if (lead === 0xe0) return [0xa0, 0xbf]
  if (lead === 0xed) return [0x80, 0x9f]
  if (lead === 0xf0) return [0x90, 0xbf]
  if (lead === 0xf4) return [0x80, 0x8f]
  return [0x80, 0xbf]
}

function decodeUtf8(raw: Uint8Array, at: number): Decoded {
  const lead = raw[at] ?? 0
  if (lead < 0x80) return { kind: 'char', cp: lead, length: 1 }
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
    return { kind: 'illegal' }
  }
  for (let i = 1; i < length; i++) {
    if (at + i >= raw.length) return { kind: 'incomplete' }
    const byte = raw[at + i] ?? 0
    const [low, high] = i === 1 ? utf8Second(lead) : [0x80, 0xbf]
    if (byte < low || byte > high) return { kind: 'illegal' }
    cp = (cp << 6) | (byte & 0x3f)
  }
  return { kind: 'char', cp, length }
}

// A UTF-16 unit, or a pair; UCS-2 (`pairs` false) refuses every surrogate.
function decodeUtf16(raw: Uint8Array, at: number, little: boolean, pairs: boolean): Decoded {
  const unit = (offset: number): number => {
    const a = raw[offset] ?? 0
    const b = raw[offset + 1] ?? 0
    return little ? a | (b << 8) : (a << 8) | b
  }
  if (at + 2 > raw.length) return { kind: 'incomplete' }
  const first = unit(at)
  if ((first >= 0xdc00 && first <= 0xdfff) || (first >= 0xd800 && first <= 0xdbff && !pairs)) {
    return { kind: 'illegal' }
  }
  if (first < 0xd800 || first > 0xdbff) return { kind: 'char', cp: first, length: 2 }
  if (at + 4 > raw.length) return { kind: 'incomplete' }
  const second = unit(at + 2)
  if (second < 0xdc00 || second > 0xdfff) return { kind: 'illegal' }
  return { kind: 'char', cp: 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00), length: 4 }
}

function decodeAt(raw: Uint8Array, at: number, charset: Charset, little: boolean): Decoded {
  const byte = raw[at] ?? 0
  if (charset === 'latin1') return { kind: 'char', cp: byte, length: 1 }
  if (charset === 'ascii') {
    return byte < 0x80 ? { kind: 'char', cp: byte, length: 1 } : { kind: 'illegal' }
  }
  if (charset === 'utf-8') return decodeUtf8(raw, at)
  return decodeUtf16(raw, at, little, charset.startsWith('utf-16'))
}

// The target side, shared by every input so a UTF-16 BOM is written once,
// before the first character. `put` writes one character at `n` and returns
// the next offset, or -1 when the charset cannot hold it. Mirrors Python's
// `_HandEncoder`.
class Encoder {
  private bom: boolean

  constructor(private readonly charset: Charset) {
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

interface Converted {
  data: Uint8Array
  dropped: boolean
  error: string | null
}

// Convert one input as glibc reports it: an input sequence the source does
// not allow, or a character the target cannot hold, stops the conversion at
// that sequence's byte offset, and -c drops it and goes on. A sequence cut
// off by the end of the input stops it either way. No conversion here more
// than doubles its input, so one buffer of twice the input (and a BOM) holds
// the output. Mirrors Python's `_walk_by_hand`.
function convert(raw: Uint8Array, charset: Charset, encoder: Encoder, omit: boolean): Converted {
  const out = new Uint8Array(raw.length * 2 + 2)
  let n = 0
  let dropped = false
  let at = 0
  let little = !charset.endsWith('be')
  if (charset === 'utf-16' && raw.length >= 2) {
    if (raw[0] === 0xff && raw[1] === 0xfe) at = 2
    else if (raw[0] === 0xfe && raw[1] === 0xff) {
      at = 2
      little = false
    }
  }
  const unit = unitOf(charset)
  const stop = (error: string): Converted => ({ data: out.subarray(0, n), dropped, error })
  while (at < raw.length) {
    const decoded = decodeAt(raw, at, charset, little)
    if (decoded.kind === 'incomplete') return stop(INCOMPLETE)
    if (decoded.kind === 'illegal') {
      if (!omit) return stop(`illegal input sequence at position ${String(at)}`)
      dropped = true
      at += unit
      continue
    }
    const next = encoder.put(decoded.cp, out, n)
    if (next < 0) {
      if (!omit) return stop(`illegal input sequence at position ${String(at)}`)
      dropped = true
    } else {
      n = next
    }
    at += decoded.length
  }
  return { data: out.subarray(0, n), dropped, error: null }
}

// Convert each input from one charset to another, in order. Follows glibc's
// iconv: -c drops what cannot be converted and exits 1; without it the output
// stops before the first such sequence and no later input is read. An input
// that cannot be opened is reported and skipped; one that opens and then
// refuses the read, a directory, ends the run. Deliberate divergence: with
// no -f or -t the charset is UTF-8, where GNU takes the locale's (ASCII under
// LC_ALL=C). Mirrors Python's `iconv`, which also converts the other charsets
// Python's codecs know.
interface IconvFlags {
  readonly fromEnc: string
  readonly toEnc: string
  readonly ignoreErrors: boolean
  readonly outputPath: string | null
}

function parseFlags(bag: Record<string, FlagValue>): IconvFlags {
  const fl = new FlagView(bag, specOf('iconv'))
  return {
    fromEnc: fl.asStr('f') ?? 'utf-8',
    toEnc: fl.asStr('t') ?? 'utf-8',
    ignoreErrors: fl.asBool('c'),
    outputPath: fl.asStr('o') ?? null,
  }
}

export async function iconvGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const parsed = parseFlags(opts.flags)
  const fromName = parsed.fromEnc
  const toName = parsed.toEnc
  const fromCharset = charsetOf(fromName)
  const toCharset = charsetOf(toName)
  if (fromCharset === null || toCharset === null) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: unsupported(fromName, toName, fromCharset !== null) }),
    ]
  }
  const encoder = new Encoder(toCharset)
  const chunks: Uint8Array[] = []
  const errors: string[] = []
  let failed = false
  for (const path of paths.length > 0 ? paths : [null]) {
    let raw: Uint8Array
    if (path === null) {
      raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
    } else {
      try {
        raw = await materialize(stream(path))
      } catch (err) {
        if (!isFsError(err)) throw err
        failed = true
        const code = (err as { code?: string }).code
        if (code !== undefined && READ_FAILURES.has(code)) {
          errors.push(`iconv: error while reading the input: ${String(fsStrerror(err))}`)
          break
        }
        errors.push(`iconv: cannot open input file \`${path.rawPath}': ${String(fsStrerror(err))}`)
        continue
      }
    }
    const converted = convert(raw, fromCharset, encoder, parsed.ignoreErrors)
    chunks.push(converted.data)
    failed = failed || converted.dropped
    if (converted.error !== null) {
      errors.push(`iconv: ${converted.error}`)
      failed = true
      break
    }
  }
  const stderr = errors.length > 0 ? ENC.encode(errors.map((line) => `${line}\n`).join('')) : null
  const encoded = concat(chunks)
  const outPath = parsed.outputPath
  if (outPath !== null) {
    const spec = PathSpec.fromStrPath(outPath, mountKey(outPath, opts.mountPrefix ?? ''))
    await write(spec, encoded)
    return [
      null,
      new IOResult({ exitCode: failed ? 1 : 0, stderr, writes: { [spec.mountPath]: encoded } }),
    ]
  }
  const result: ByteSource = encoded
  return [result, new IOResult({ exitCode: failed ? 1 : 0, stderr })]
}
