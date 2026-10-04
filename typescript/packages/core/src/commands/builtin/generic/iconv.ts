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
import { mountKey } from '../../../utils/key_prefix.ts'
import { READ_FAILURES, fsStrerror, isFsError } from '../../../utils/errors.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync, stdinStream } from '../utils/stream.ts'

const ENC = new TextEncoder()

const HINT = "Try `iconv --help' or `iconv --usage' for more information."
const INCOMPLETE = 'incomplete character or shift sequence at end of buffer'

type Charset = 'utf-8' | 'utf-16' | 'utf-16le' | 'utf-16be' | 'latin1' | 'ascii'

// The names glibc and Python's codec lookup both read for the charsets this
// host converts. glibc's //TRANSLIT and //IGNORE suffixes are not supported.
const CHARSETS: Record<string, Charset> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'utf-16': 'utf-16',
  utf16: 'utf-16',
  'utf-16le': 'utf-16le',
  utf16le: 'utf-16le',
  'utf-16be': 'utf-16be',
  utf16be: 'utf-16be',
  latin1: 'latin1',
  'latin-1': 'latin1',
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  'iso_8859-1': 'latin1',
  l1: 'latin1',
  ascii: 'ascii',
  'us-ascii': 'ascii',
  'ansi_x3.4-1968': 'ascii',
}

function charsetOf(name: string): Charset | null {
  return CHARSETS[name.toLowerCase()] ?? null
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

function decodeUtf16(raw: Uint8Array, at: number, little: boolean): Decoded {
  const unit = (offset: number): number => {
    const a = raw[offset] ?? 0
    const b = raw[offset + 1] ?? 0
    return little ? a | (b << 8) : (a << 8) | b
  }
  if (at + 2 > raw.length) return { kind: 'incomplete' }
  const first = unit(at)
  if (first >= 0xdc00 && first <= 0xdfff) return { kind: 'illegal' }
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
  return decodeUtf16(raw, at, little)
}

function utf8Bytes(cp: number): number[] {
  if (cp < 0x80) return [cp]
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)]
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)]
  return [
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  ]
}

function utf16Units(cp: number, little: boolean): number[] {
  const units = cp < 0x10000 ? [cp] : [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + (cp & 0x3ff)]
  return units.flatMap((u) => (little ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]))
}

// The target side, shared by every input so a UTF-16 BOM is written once,
// before the first character.
class Encoder {
  private bom: boolean

  constructor(private readonly charset: Charset) {
    this.bom = charset === 'utf-16'
  }

  encode(cp: number): number[] | null {
    if (this.charset === 'ascii') return cp < 0x80 ? [cp] : null
    if (this.charset === 'latin1') return cp < 0x100 ? [cp] : null
    if (this.charset === 'utf-8') return utf8Bytes(cp)
    const bytes = utf16Units(cp, this.charset !== 'utf-16be')
    if (!this.bom) return bytes
    this.bom = false
    return [0xff, 0xfe, ...bytes]
  }
}

interface Converted {
  data: number[]
  dropped: boolean
  error: string | null
}

// Convert one input as glibc reports it: an input sequence the source does
// not allow, or a character the target cannot hold, stops the conversion at
// that sequence's byte offset, and -c drops it and goes on. A sequence cut
// off by the end of the input stops it either way. Mirrors Python's
// `_convert_slowly`.
function convert(raw: Uint8Array, charset: Charset, encoder: Encoder, omit: boolean): Converted {
  const data: number[] = []
  let dropped = false
  let at = 0
  let little = true
  if (charset === 'utf-16' && raw.length >= 2) {
    if (raw[0] === 0xff && raw[1] === 0xfe) at = 2
    else if (raw[0] === 0xfe && raw[1] === 0xff) {
      at = 2
      little = false
    }
  }
  if (charset === 'utf-16be') little = false
  while (at < raw.length) {
    const decoded = decodeAt(raw, at, charset, little)
    if (decoded.kind === 'incomplete') return { data, dropped, error: INCOMPLETE }
    if (decoded.kind === 'illegal') {
      if (!omit) return { data, dropped, error: `illegal input sequence at position ${String(at)}` }
      dropped = true
      at += 1
      continue
    }
    const bytes = encoder.encode(decoded.cp)
    if (bytes === null) {
      if (!omit) return { data, dropped, error: `illegal input sequence at position ${String(at)}` }
      dropped = true
    } else {
      for (const byte of bytes) data.push(byte)
    }
    at += decoded.length
  }
  return { data, dropped, error: null }
}

// Convert each input from one charset to another, in order. Follows glibc's
// iconv: -c drops what cannot be converted and exits 1; without it the output
// stops before the first such sequence and no later input is read. An input
// that cannot be opened is reported and skipped; one that opens and then
// refuses the read, a directory, ends the run. Deliberate divergence: with
// no -f or -t the charset is UTF-8, where GNU takes the locale's (ASCII under
// LC_ALL=C). Mirrors Python's `iconv`, which also converts the other charsets
// Python's codecs know.
export async function iconvGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const fl = new FlagView(opts.flags, specOf('iconv'))
  const fromName = fl.asStr('f') ?? 'utf-8'
  const toName = fl.asStr('t') ?? 'utf-8'
  const fromCharset = charsetOf(fromName)
  const toCharset = charsetOf(toName)
  if (fromCharset === null || toCharset === null) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: unsupported(fromName, toName, fromCharset !== null) }),
    ]
  }
  const encoder = new Encoder(toCharset)
  const out: number[] = []
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
    const converted = convert(raw, fromCharset, encoder, fl.asBool('c'))
    for (const byte of converted.data) out.push(byte)
    failed = failed || converted.dropped
    if (converted.error !== null) {
      errors.push(`iconv: ${converted.error}`)
      failed = true
      break
    }
  }
  const stderr = errors.length > 0 ? ENC.encode(errors.map((line) => `${line}\n`).join('')) : null
  const encoded = Uint8Array.from(out)
  const outPath = fl.asStr('o') ?? null
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
