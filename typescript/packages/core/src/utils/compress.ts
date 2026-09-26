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
  ZStream,
  Z_NO_FLUSH,
  Z_OK,
  Z_STREAM_END,
  Z_BUF_ERROR,
  zlibInflate,
  zlibInflateInit2,
  zlibInflateEnd,
} from 'pako'
import { yieldBytes } from '../io/stream.ts'
import { concat } from '../io/cachable_iterator.ts'
import { GzipDataError } from './errors.ts'

// gzip 1.13's words for the inputs `gzip -d` refuses, `{}` standing for the
// input's name.
const GZIP_NOT_GZIP = '{}: not in gzip format'
const GZIP_EOF = '{}: unexpected end of file'
const GZIP_CORRUPT = '{}: invalid compressed data--format violated'
const GZIP_CRC = '{}: invalid compressed data--crc error'
const GZIP_LENGTH = '{}: invalid compressed data--length error'
const GZIP_ENCRYPTED = '{} is encrypted -- not supported'
const GZIP_TRAILING = '{}: decompression OK, trailing garbage ignored'
// The member layout of gzip.h: method 8 is deflate, the flag bits announce
// the optional header fields, and the CRC-32 and the length modulo 2**32 of
// the decoded bytes close the member.
const GZIP_DEFLATED = 8
const GZIP_HEADER_CRC = 0x02
const GZIP_EXTRA_FIELD = 0x04
const GZIP_ORIG_NAME = 0x08
const GZIP_COMMENT = 0x10
const GZIP_ENCRYPTED_FLAG = 0x20
const GZIP_RESERVED = 0xc0
const GZIP_FIXED_HEADER = 10
const GZIP_TRAILER = 8
export const GZIP_CHUNK_SIZE = 65536

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** The CRC-32 of `data`, continuing from the CRC of the bytes before it. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.byteLength; i++) {
    c = (CRC_TABLE[((c ^ (data[i] ?? 0)) & 0xff) >>> 0] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function littleEndian(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0
  for (let i = width - 1; i >= 0; i--) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

async function runThrough(
  bytes: Uint8Array,
  transform: GenericTransformStream,
): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart])
  const piped = blob.stream().pipeThrough(transform)
  const buf = await new Response(piped).arrayBuffer()
  return new Uint8Array(buf)
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new CompressionStream('gzip'))
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new DecompressionStream('gzip'))
}

/** Whether bytes open with the gzip magic. */
export function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

// Which part of a gzip member the decoder is reading.
type MemberPart = 'header' | 'body' | 'trailer'
type HeaderPart = 'fixed' | 'extraLength' | 'extra' | 'name' | 'comment' | 'crc' | 'done'

/**
 * Incremental member decoder with bounded decompressed chunks.
 *
 * Frames each member as gzip 1.13 does: it reads the header itself, inflates
 * the body raw, and checks the CRC and length trailer only after handing out
 * what it inflated, so a damaged trailer costs the diagnostic and not the
 * data. gzip ends the run on a mismatch unless it is only testing
 * (`gzip -t`), and then moves to the next input. A header gzip does not
 * support skips the input, and keeps the members before it when it is not
 * the first.
 */
class GzipDecoder {
  private part: MemberPart = 'header'
  private inflater: ZStream | null = null
  private crc = 0
  private size = 0
  private seen = false
  private pending: Uint8Array = new Uint8Array()
  private padding = false
  private headerPart: HeaderPart = 'fixed'
  private headerFlags = 0
  private headerCrc = 0
  private extraRemaining = 0

  constructor(private readonly test = false) {}

  // A refusal that skips the input, keeping any complete member.
  private refusal(reason: string, exitCode = 1): GzipDataError {
    return new GzipDataError([reason], false, exitCode, this.seen)
  }

  // Consume variable fields as they arrive, retaining only incomplete fixed
  // fields. The running CRC includes every header byte except its own field.
  private readHeader(data: Uint8Array): number | null {
    let offset = 0
    while (this.headerPart !== 'done') {
      const start = offset
      const available = data.byteLength - offset
      const part = this.headerPart
      if (part === 'fixed') {
        if (available >= 2 && !hasGzipMagic(data)) {
          throw this.seen ? this.refusal(GZIP_TRAILING, 2) : this.refusal(GZIP_NOT_GZIP)
        }
        const method = data[2] ?? 0
        if (available >= 3 && method !== GZIP_DEFLATED) {
          throw this.refusal(`{}: unknown method ${String(method)} -- not supported`)
        }
        if (available >= 4) {
          this.headerFlags = data[3] ?? 0
          if (this.headerFlags & GZIP_ENCRYPTED_FLAG) throw this.refusal(GZIP_ENCRYPTED)
          if (this.headerFlags & GZIP_RESERVED) {
            throw this.refusal(`{} has flags 0x${this.headerFlags.toString(16)} -- not supported`)
          }
        }
        if (available < GZIP_FIXED_HEADER) {
          this.pending = data.slice(offset)
          return null
        }
        offset += GZIP_FIXED_HEADER
        this.headerPart = 'extraLength'
      } else if (part === 'extraLength') {
        if (this.headerFlags & GZIP_EXTRA_FIELD) {
          if (available < 2) {
            this.pending = data.slice(offset)
            return null
          }
          this.extraRemaining = littleEndian(data, offset, 2)
          offset += 2
        }
        this.headerPart = 'extra'
      } else if (part === 'extra') {
        const count = Math.min(available, this.extraRemaining)
        offset += count
        this.extraRemaining -= count
        if (this.extraRemaining === 0) this.headerPart = 'name'
      } else if (part === 'name' || part === 'comment') {
        const flag = part === 'name' ? GZIP_ORIG_NAME : GZIP_COMMENT
        if (this.headerFlags & flag) {
          const nul = data.indexOf(0, offset)
          offset = nul === -1 ? data.byteLength : nul + 1
          if (nul === -1) {
            this.headerCrc = crc32(data.subarray(start, offset), this.headerCrc)
            return null
          }
        }
        this.headerPart = part === 'name' ? 'comment' : 'crc'
      } else {
        if (this.headerFlags & GZIP_HEADER_CRC) {
          if (available < 2) {
            this.pending = data.slice(offset)
            return null
          }
          const stored = littleEndian(data, offset, 2)
          const computed = this.headerCrc & 0xffff
          if (stored !== computed) {
            const storedHex = stored.toString(16).padStart(4, '0')
            const computedHex = computed.toString(16).padStart(4, '0')
            throw this.refusal(
              `{}: header checksum 0x${storedHex} != computed checksum 0x${computedHex}`,
            )
          }
          offset += 2
        }
        this.headerPart = 'done'
      }
      if (part !== 'crc') this.headerCrc = crc32(data.subarray(start, offset), this.headerCrc)
      if (this.headerPart === part) return null
    }
    return offset
  }

  *feed(input: Uint8Array): Generator<Uint8Array> {
    let data = this.pending.byteLength > 0 ? concat([this.pending, input]) : input
    this.pending = new Uint8Array()
    while (data.byteLength > 0) {
      if (this.part === 'header') {
        if (this.headerPart === 'fixed' && this.seen && (this.padding || data[0] === 0)) {
          this.padding = true
          if (data.some((byte) => byte !== 0)) throw this.refusal(GZIP_TRAILING, 2)
          return
        }
        const end = this.readHeader(data)
        if (end === null) return
        data = data.subarray(end)
        this.inflater = new ZStream()
        if (zlibInflateInit2(this.inflater, -15) !== Z_OK)
          throw new Error('gzip decoder initialization failed')
        this.crc = 0
        this.size = 0
        this.part = 'body'
      } else if (this.part === 'body') {
        data = yield* this.inflate(data)
      } else {
        if (data.byteLength < GZIP_TRAILER) {
          this.pending = data.slice()
          return
        }
        this.check(data.subarray(0, GZIP_TRAILER))
        data = data.subarray(GZIP_TRAILER)
        this.seen = true
        this.part = 'header'
        this.headerPart = 'fixed'
        this.headerCrc = 0
      }
    }
  }

  // Inflate body bytes, yielding bounded chunks as they decode; returns the
  // input left over once the body ends, else nothing.
  private *inflate(data: Uint8Array): Generator<Uint8Array, Uint8Array> {
    const inflater = this.inflater
    if (inflater === null) throw new Error('gzip body without a decoder')
    inflater.input = data
    inflater.next_in = 0
    inflater.avail_in = data.byteLength
    do {
      inflater.output = new Uint8Array(GZIP_CHUNK_SIZE)
      inflater.next_out = 0
      inflater.avail_out = GZIP_CHUNK_SIZE
      const status = zlibInflate(inflater, Z_NO_FLUSH)
      if (inflater.next_out > 0) {
        const out = inflater.output.subarray(0, inflater.next_out)
        this.crc = crc32(out, this.crc)
        this.size += out.byteLength
        yield out
      }
      if (status === Z_STREAM_END) {
        const rest = data.subarray(inflater.next_in)
        this.close()
        this.part = 'trailer'
        return rest
      }
      if (status !== Z_OK && status !== Z_BUF_ERROR) throw new GzipDataError([GZIP_CORRUPT], true)
    } while (inflater.avail_in > 0 || inflater.avail_out === 0)
    return new Uint8Array()
  }

  // Compare a member's trailer with the bytes it decoded to.
  private check(trailer: Uint8Array): void {
    const reasons: string[] = []
    if (littleEndian(trailer, 0, 4) !== this.crc) reasons.push(GZIP_CRC)
    if (littleEndian(trailer, 4, 4) !== this.size % 2 ** 32) reasons.push(GZIP_LENGTH)
    if (reasons.length > 0) throw new GzipDataError(reasons, !this.test, 1, true)
  }

  // GNU gzip 1.13 treats a single trailing nonzero byte as fatal EOF;
  // the trailing-garbage warning requires at least two bytes. Missing trailers
  // or partial next headers leave complete bodies for tar, but stay fatal.
  finish(): void {
    if (
      !this.seen ||
      this.part !== 'header' ||
      this.pending.byteLength > 0 ||
      this.headerPart !== 'fixed'
    ) {
      const whole = this.part === 'trailer' || (this.part === 'header' && this.seen)
      throw new GzipDataError([GZIP_EOF], true, 1, whole)
    }
  }

  close(): void {
    if (this.inflater !== null) zlibInflateEnd(this.inflater)
    this.inflater = null
  }
}

/** Decode gzip members with bounded output chunks and consumer backpressure. */
export async function* gunzipStream(
  source: AsyncIterable<Uint8Array>,
  test = false,
): AsyncIterable<Uint8Array> {
  const decoder = new GzipDecoder(test)
  try {
    for await (const chunk of source) yield* decoder.feed(chunk)
    decoder.finish()
  } finally {
    decoder.close()
  }
}

/** What `gzip -d` writes from `bytes` before it stops, and why. */
export async function gunzipPartial(
  bytes: Uint8Array,
): Promise<[Uint8Array, GzipDataError | null]> {
  const parts: Uint8Array[] = []
  try {
    for await (const part of gunzipStream(yieldBytes(bytes))) parts.push(part)
  } catch (err) {
    if (!(err instanceof GzipDataError)) throw err
    return [concat(parts), err]
  }
  return [concat(parts), null]
}

/** Materialize checked gzip for consumers that need the whole decoded file. */
export async function gunzipChecked(bytes: Uint8Array): Promise<Uint8Array> {
  const [decoded, failure] = await gunzipPartial(bytes)
  if (failure !== null) throw failure
  return decoded
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new CompressionStream('deflate-raw'))
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new DecompressionStream('deflate-raw'))
}

// `compress` is optional because a codec may be decompress-only: every
// permissively licensed bzip2 implementation decompresses only, so mirage
// reads a .tar.bz2 and refuses to create one.
export interface CompressionCodec {
  compress?(bytes: Uint8Array): Promise<Uint8Array>
  decompress(bytes: Uint8Array): Promise<Uint8Array>
}

const codecs = new Map<string, CompressionCodec>()

// gzip ships in every runtime via CompressionStream; heavier codecs (bzip2,
// xz) are registered by the runtime package that bundles a dependency for
// them. Browser core leaves them unregistered, so tar -j/-J report
// "not supported" there.
export function registerCompressionCodec(name: string, codec: CompressionCodec): void {
  codecs.set(name, codec)
}

export function getCompressionCodec(name: string): CompressionCodec | undefined {
  return codecs.get(name)
}
