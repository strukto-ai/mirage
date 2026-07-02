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

import { mountKey } from '../../../utils/key_prefix.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()

type EncodingId = 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin1' | 'ascii'

const ENCODING_ALIASES: Record<string, EncodingId> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'utf-16le': 'utf-16le',
  utf16le: 'utf-16le',
  ucs2: 'utf-16le',
  'ucs-2': 'utf-16le',
  'utf-16be': 'utf-16be',
  utf16be: 'utf-16be',
  latin1: 'latin1',
  iso88591: 'latin1',
  'iso-8859-1': 'latin1',
  ascii: 'ascii',
}

function normalizeEncoding(name: string): EncodingId | null {
  const lower = name.toLowerCase().replace(/_/g, '-')
  return ENCODING_ALIASES[lower] ?? ENCODING_ALIASES[lower.replace(/-/g, '')] ?? null
}

function decodeUtf16BE(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const chars: string[] = []
  for (let i = 0; i + 1 < data.byteLength; i += 2) {
    chars.push(String.fromCharCode(view.getUint16(i, false)))
  }
  return chars.join('')
}

function encodeUtf16BE(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < text.length; i++) {
    view.setUint16(i * 2, text.charCodeAt(i), false)
  }
  return out
}

function decodeLatin1(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.byteLength; i++) s += String.fromCharCode(data[i] ?? 0)
  return s
}

function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function decodeAscii(data: Uint8Array): string {
  let s = ''
  for (let i = 0; i < data.byteLength; i++) s += String.fromCharCode((data[i] ?? 0) & 0x7f)
  return s
}

function encodeAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f
  return out
}

function decodeBytes(data: Uint8Array, enc: EncodingId): string {
  if (enc === 'utf-8') return new TextDecoder('utf-8', { fatal: false }).decode(data)
  if (enc === 'utf-16le') return new TextDecoder('utf-16le', { fatal: false }).decode(data)
  if (enc === 'utf-16be') return decodeUtf16BE(data)
  if (enc === 'latin1') return decodeLatin1(data)
  return decodeAscii(data)
}

function encodeText(text: string, enc: EncodingId): Uint8Array {
  if (enc === 'utf-8') return new TextEncoder().encode(text)
  if (enc === 'utf-16le') {
    const out = new Uint8Array(text.length * 2)
    const view = new DataView(out.buffer)
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true)
    return out
  }
  if (enc === 'utf-16be') return encodeUtf16BE(text)
  if (enc === 'latin1') return encodeLatin1(text)
  return encodeAscii(text)
}

export async function iconvGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const fromName = typeof opts.flags.f === 'string' ? opts.flags.f : 'utf-8'
  const toName = typeof opts.flags.t === 'string' ? opts.flags.t : 'utf-8'
  const fromEnc = normalizeEncoding(fromName)
  const toEnc = normalizeEncoding(toName)
  if (fromEnc === null) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`iconv: unsupported encoding: ${fromName}\n`),
      }),
    ]
  }
  if (toEnc === null) {
    return [
      null,
      new IOResult({ exitCode: 1, stderr: ENC.encode(`iconv: unsupported encoding: ${toName}\n`) }),
    ]
  }
  let raw: Uint8Array
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    raw = await materialize(stream(first))
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    raw = stdinData ?? new Uint8Array(0)
  }
  const decoded = decodeBytes(raw, fromEnc)
  const encoded = encodeText(decoded, toEnc)
  const outPath = typeof opts.flags.o === 'string' ? opts.flags.o : null
  if (outPath !== null) {
    const spec = PathSpec.fromStrPath(outPath, mountKey(outPath, opts.mountPrefix ?? ''))
    await write(spec, encoded)
    return [null, new IOResult({ writes: { [spec.mountPath]: encoded } })]
  }
  const result: ByteSource = encoded
  return [result, new IOResult()]
}
