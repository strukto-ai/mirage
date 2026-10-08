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

import { toHex } from '../../../utils/hex.ts'

/** Opt in before conversion by assigning a debug sink; tables are cached after first use. */
export const logger: { debug?: (message: string) => void } = {}

export const ILLEGAL = -1
export const CUT = -2

// One decoded character as (code point, bytes used); the code point is
// ILLEGAL or CUT when there is none.
export type Decoded = readonly [number, number]
export type Table = ReadonlyMap<number, number>
export type ByteRanges = readonly (readonly [number, number])[]
export type Block = readonly ByteRanges[]
export type StepFn = (raw: Uint8Array, at: number, table: Table) => Decoded

export const GBK_TRAIL: ByteRanges = [
  [0x40, 0x7e],
  [0x80, 0xfe],
]
export const SJIS_TRAIL: ByteRanges = [
  [0x40, 0x7e],
  [0x80, 0xfc],
]
export const EUC_BYTE: ByteRanges = [[0xa1, 0xfe]]
export const FOUR_DIGIT: ByteRanges = [[0x30, 0x39]]
export const FOUR_LETTER: ByteRanges = [[0x81, 0xfe]]
export const PRIVATE_USE: readonly [number, number] = [0xe000, 0xf8ff]
export const HALFWIDTH_KATAKANA = 0xfec0
export const SUPPLEMENTARY_LEAD: readonly [number, number] = [0x90, 0xe3]
export const LAST_CODE_POINT = 0x10ffff

function key(raw: Uint8Array, at: number, width: number): number {
  let out = 0
  for (let i = 0; i < width; i++) out = out * 256 + (raw[at + i] ?? 0)
  return out
}

/** How many bytes a sequence spans, one to four. */
function width(k: number): number {
  if (k > 0xffff) return k > 0xffffff ? 4 : 3
  return k > 0xff ? 2 : 1
}

function pair(raw: Uint8Array, at: number, table: Table, unmapped: number): Decoded {
  const cp = table.get(key(raw, at, 2))
  return cp !== undefined ? [cp, 2] : [ILLEGAL, unmapped]
}

/** One GBK character, as glibc 2.41's `gbk.c` reads it. */
export function gbkStep(raw: Uint8Array, at: number, table: Table): Decoded {
  const lead = raw[at] ?? 0
  if (lead < 0x80) return [lead, 1]
  if (lead === 0x80) return [0x20ac, 1]
  if (lead === 0xff) return [ILLEGAL, 1]
  if (at + 1 >= raw.length) return [CUT, 0]
  const trail = raw[at + 1] ?? 0
  if (trail < 0x40 || trail === 0xff || (lead === 0xfe && trail > 0xa0)) return [ILLEGAL, 1]
  return pair(raw, at, table, 2)
}

/** One EUC-CN (GB2312) character, as glibc's `euc-cn.c` reads it. */
export function eucCnStep(raw: Uint8Array, at: number, table: Table): Decoded {
  const lead = raw[at] ?? 0
  if (lead < 0x80) return [lead, 1]
  if ((lead <= 0xa0 && lead !== 0x8e && lead !== 0x8f) || lead === 0xff) return [ILLEGAL, 1]
  if (at + 1 >= raw.length) return [CUT, 0]
  if ((raw[at + 1] ?? 0) < 0xa1) return [ILLEGAL, 1]
  return pair(raw, at, table, 2)
}

/**
 * One EUC-KR character, as glibc's `euc-kr.c` reads it.
 *
 * Bytes up to 0x9F stand for themselves, C1 controls included, and a
 * refused pair is skipped whole whatever its second byte is.
 */
export function eucKrStep(raw: Uint8Array, at: number, table: Table): Decoded {
  const lead = raw[at] ?? 0
  if (lead <= 0x9f) return [lead, 1]
  if (lead === 0xa0) return [ILLEGAL, 1]
  if (at + 1 >= raw.length) return [CUT, 0]
  return pair(raw, at, table, 2)
}

/**
 * One Shift_JIS character, as glibc's `sjis.c` reads it.
 *
 * glibc reads 0x5C as YEN SIGN and 0x7E as OVERLINE, JIS X 0201's Roman
 * half, and 0xA1-0xDF as half-width katakana.
 */
export function sjisStep(raw: Uint8Array, at: number, table: Table): Decoded {
  const lead = raw[at] ?? 0
  if (lead === 0x5c) return [0xa5, 1]
  if (lead === 0x7e) return [0x203e, 1]
  if (lead < 0x80) return [lead, 1]
  if (lead >= 0xa1 && lead <= 0xdf) return [lead + HALFWIDTH_KATAKANA, 1]
  if (lead === 0x80 || lead === 0xa0 || lead > 0xea) return [ILLEGAL, 1]
  if (at + 1 >= raw.length) return [CUT, 0]
  if ((raw[at + 1] ?? 0) < 0x40) return [ILLEGAL, 1]
  return pair(raw, at, table, 2)
}

/**
 * One EUC-JP character, as glibc's `euc-jp.c` reads it.
 *
 * Code set 2 (0x8E) is half-width katakana and code set 3 (0x8F) JIS X
 * 0212, whose rows outside 0x22-0x6D glibc refuses before it asks for the
 * third byte. glibc skips one byte of any refused sequence.
 */
export function eucJpStep(raw: Uint8Array, at: number, table: Table): Decoded {
  const lead = raw[at] ?? 0
  if (lead < 0x8e || (lead >= 0x90 && lead <= 0x9f)) return [lead, 1]
  if (lead === 0xff) return [ILLEGAL, 1]
  if (at + 1 >= raw.length) return [CUT, 0]
  const second = raw[at + 1] ?? 0
  if (second < 0xa1) return [ILLEGAL, 1]
  if (lead === 0x8f) {
    if (second < 0xa2 || second > 0xed) return [ILLEGAL, 1]
    if (at + 2 >= raw.length) return [CUT, 0]
    const cp = table.get(key(raw, at, 3))
    return cp !== undefined ? [cp, 3] : [ILLEGAL, 1]
  }
  return pair(raw, at, table, 1)
}

/**
 * The code point of a GB18030 four-byte sequence past the BMP.
 *
 * Planes 1-16 are a straight count from 0x90308130.
 */
function supplementary(raw: Uint8Array, at: number): number | null {
  const b1 = raw[at] ?? 0
  const b2 = raw[at + 1] ?? 0
  const b3 = raw[at + 2] ?? 0
  const b4 = raw[at + 3] ?? 0
  const index = (((b1 - 0x90) * 10 + (b2 - 0x30)) * 126 + (b3 - 0x81)) * 10
  const cp = 0x10000 + index + (b4 - 0x30)
  return cp <= LAST_CODE_POINT ? cp : null
}

/** One GB18030 character, as glibc's `gb18030.c` reads it. */
export function gb18030Step(raw: Uint8Array, at: number, table: Table): Decoded {
  const lead = raw[at] ?? 0
  if (lead < 0x80) return [lead, 1]
  if (lead === 0x80 || lead === 0xff) return [ILLEGAL, 1]
  if (at + 1 >= raw.length) return [CUT, 0]
  const second = raw[at + 1] ?? 0
  if (second >= 0x30 && second <= 0x39) {
    if (at + 3 >= raw.length) return [CUT, 0]
    const third = raw[at + 2] ?? 0
    const fourth = raw[at + 3] ?? 0
    if (third < 0x81 || third > 0xfe) return [ILLEGAL, 3]
    if (fourth < 0x30 || fourth > 0x39) return [ILLEGAL, 4]
    const cp =
      lead >= SUPPLEMENTARY_LEAD[0] && lead <= SUPPLEMENTARY_LEAD[1]
        ? supplementary(raw, at)
        : (table.get(key(raw, at, 4)) ?? null)
    return cp !== null ? [cp, 4] : [ILLEGAL, 4]
  }
  if (second < 0x40 || second === 0x7f || second === 0xff) return [ILLEGAL, 2]
  return pair(raw, at, table, 2)
}

/**
 * One multi-byte charset: glibc's grammar over a host-seeded table.
 *
 * The table is what the host's own decoder (the platform `TextDecoder`
 * here, a codec in Python) answers for every sequence in `blocks`, then
 * corrected to glibc 2.41: `remapped` sets the sequences where a host
 * disagrees with glibc, `excluded` drops the ranges a host decodes and
 * glibc does not, and a private-use answer is dropped unless glibc maps
 * into that area. The corrections cover CPython's codecs, ICU's (Node) and
 * WHATWG's (browsers), so every host builds the same table. Measured byte
 * for byte on debian:stable-slim. `oneWay` holds the code points glibc
 * encodes to a sequence that decodes to another one, and `supplementary`
 * counts planes 1-16 out by four-byte sequences (GB18030). A sequence is
 * its bytes read big-endian.
 */
export interface MultibyteSpec {
  readonly name: string
  readonly codec: string
  readonly step: StepFn
  readonly blocks: readonly Block[]
  readonly remapped: readonly (readonly [number, number])[]
  readonly excluded: readonly (readonly [number, number])[]
  readonly privateUse: boolean
  readonly oneWay: readonly (readonly [number, number])[]
  readonly supplementary: boolean
}

/** A spec with the corrections it does not name left empty. */
function multibyteSpec(
  spec: Pick<MultibyteSpec, 'name' | 'codec' | 'step' | 'blocks'> & Partial<MultibyteSpec>,
): MultibyteSpec {
  return {
    remapped: [],
    excluded: [],
    privateUse: false,
    oneWay: [],
    supplementary: false,
    ...spec,
  }
}

export const GBK = multibyteSpec({
  name: 'GBK',
  codec: 'gbk',
  step: gbkStep,
  blocks: [
    [[[0x81, 0xfd]], GBK_TRAIL],
    [
      [[0xfe, 0xfe]],
      [
        [0x40, 0x7e],
        [0x80, 0xa0],
      ],
    ],
  ],
  excluded: [
    [0xa2e3, 0xa2e3],
    [0xa3a0, 0xa3a0],
    [0xa6d9, 0xa6df],
    [0xa6ec, 0xa6ed],
    [0xa6f3, 0xa6f3],
    [0xa8bc, 0xa8bc],
    [0xa8bf, 0xa8bf],
    [0xa989, 0xa995],
    [0xfe50, 0xfe50],
    [0xfe54, 0xfe6b],
    [0xfe6d, 0xfe75],
    [0xfe77, 0xfe7e],
    [0xfe80, 0xfe90],
    [0xfe92, 0xfea0],
  ],
})

export const EUC_CN = multibyteSpec({
  name: 'EUC-CN',
  codec: 'gb2312',
  step: eucCnStep,
  blocks: [[[[0xa1, 0xf7]], EUC_BYTE]],
  remapped: [
    [0xa1a4, 0x30fb],
    [0xa1aa, 0x2015],
  ],
  excluded: [
    [0xa2a1, 0xa2aa],
    [0xa2e3, 0xa2e3],
    [0xa6d9, 0xa6f5],
    [0xa8bb, 0xa8c0],
  ],
})

export const GB18030 = multibyteSpec({
  name: 'GB18030',
  codec: 'gb18030',
  step: gb18030Step,
  blocks: [
    [FOUR_LETTER, GBK_TRAIL],
    [[[0x81, 0x83]], FOUR_DIGIT, FOUR_LETTER, FOUR_DIGIT],
    [[[0x84, 0x84]], [[0x30, 0x30]], FOUR_LETTER, FOUR_DIGIT],
    [[[0x84, 0x84]], [[0x31, 0x31]], [[0x81, 0xa4]], FOUR_DIGIT],
  ],
  remapped: [
    [0x8135f437, 0xe7c7],
    [0x82359037, 0xe81e],
    [0x82359038, 0xe826],
    [0x82359039, 0xe82b],
    [0x82359130, 0xe82c],
    [0x82359131, 0xe832],
    [0x82359132, 0xe843],
    [0x82359133, 0xe854],
    [0x82359134, 0xe864],
    [0x84318236, 0xe78d],
    [0x84318237, 0xe78f],
    [0x84318238, 0xe78e],
    [0x84318239, 0xe790],
    [0x84318330, 0xe791],
    [0x84318331, 0xe792],
    [0x84318332, 0xe793],
    [0x84318333, 0xe794],
    [0x84318334, 0xe795],
    [0x84318335, 0xe796],
    [0xa3a0, 0xe5e5],
    [0xa6d9, 0xfe10],
    [0xa6da, 0xfe12],
    [0xa6db, 0xfe11],
    [0xa6dc, 0xfe13],
    [0xa6dd, 0xfe14],
    [0xa6de, 0xfe15],
    [0xa6df, 0xfe16],
    [0xa6ec, 0xfe17],
    [0xa6ed, 0xfe18],
    [0xa6f3, 0xfe19],
    [0xa8bc, 0x1e3f],
    [0xfe59, 0x9fb4],
    [0xfe61, 0x9fb5],
    [0xfe66, 0x9fb6],
    [0xfe67, 0x9fb7],
    [0xfe6d, 0x9fb8],
    [0xfe7e, 0x9fb9],
    [0xfe90, 0x9fba],
    [0xfea0, 0x9fbb],
  ],
  privateUse: true,
  supplementary: true,
})

export const EUC_KR = multibyteSpec({
  name: 'EUC-KR',
  codec: 'euc-kr',
  step: eucKrStep,
  blocks: [[EUC_BYTE, EUC_BYTE]],
  remapped: [
    [0xa2e6, 0x20ac],
    [0xa2e7, 0xae],
    [0xa2e8, 0x327e],
    [0xa4d4, 0x3164],
  ],
  oneWay: [[0x20a9, 0xa3dc]],
})

export const SJIS = multibyteSpec({
  name: 'SJIS',
  codec: 'shift_jis',
  step: sjisStep,
  blocks: [
    [[[0x81, 0x9f]], SJIS_TRAIL],
    [[[0xe0, 0xea]], SJIS_TRAIL],
  ],
  remapped: [
    [0x8160, 0x301c],
    [0x8161, 0x2016],
    [0x817c, 0x2212],
    [0x8191, 0xa2],
    [0x8192, 0xa3],
    [0x81ca, 0xac],
  ],
  excluded: [
    [0x8740, 0x875d],
    [0x875f, 0x8775],
    [0x877e, 0x877e],
    [0x8780, 0x879c],
  ],
  oneWay: [
    [0x5c, 0x5c],
    [0x7e, 0x7e],
    [0xffe0, 0x8191],
    [0xffe1, 0x8192],
    [0xffe2, 0x81ca],
  ],
})

export const EUC_JP = multibyteSpec({
  name: 'EUC-JP',
  codec: 'euc-jp',
  step: eucJpStep,
  blocks: [
    [EUC_BYTE, EUC_BYTE],
    [[[0x8e, 0x8e]], [[0xa1, 0xdf]]],
    [[[0x8f, 0x8f]], [[0xa2, 0xed]], EUC_BYTE],
  ],
  remapped: [
    [0x8fa2b7, 0xff5e],
    [0xa1c1, 0x301c],
    [0xa1c2, 0x2016],
    [0xa1dd, 0x2212],
    [0xa1f1, 0xa2],
    [0xa1f2, 0xa3],
    [0xa2cc, 0xac],
  ],
  excluded: [
    [0xada1, 0xadbe],
    [0xadc0, 0xadd6],
    [0xaddf, 0xadfc],
    [0xf9a1, 0xf9fe],
    [0xfaa1, 0xfafe],
    [0xfba1, 0xfbfe],
    [0xfca1, 0xfcee],
    [0xfcf1, 0xfcfe],
  ],
  oneWay: [
    [0xa5, 0x5c],
    [0x203e, 0x7e],
  ],
})

export const MULTIBYTE_CHARSETS: Readonly<Record<string, MultibyteSpec>> = {
  GBK,
  GB13000: GBK,
  CP936: GBK,
  MS936: GBK,
  'WINDOWS-936': GBK,
  'EUC-CN': EUC_CN,
  EUCCN: EUC_CN,
  GB2312: EUC_CN,
  CSGB2312: EUC_CN,
  'CN-GB': EUC_CN,
  GB18030,
  'EUC-KR': EUC_KR,
  EUCKR: EUC_KR,
  CSEUCKR: EUC_KR,
  OSF0004000A: EUC_KR,
  SJIS,
  'SHIFT-JIS': SJIS,
  SHIFT_JIS: SJIS,
  MS_KANJI: SJIS,
  CSSHIFTJIS: SJIS,
  'EUC-JP': EUC_JP,
  EUCJP: EUC_JP,
  UJIS: EUC_JP,
  CSEUCPKDFMTJAPANESE: EUC_JP,
  OSF00030010: EUC_JP,
}

/** Every sequence the blocks span, in block then byte order. */
function* sequences(blocks: readonly Block[]): Generator<Uint8Array> {
  for (const block of blocks) {
    const seq = new Uint8Array(block.length)
    function* fill(depth: number): Generator<Uint8Array> {
      if (depth === block.length) {
        yield seq.slice()
        return
      }
      for (const [low, high] of block[depth] ?? []) {
        for (let byte = low; byte <= high; byte++) {
          seq[depth] = byte
          yield* fill(depth + 1)
        }
      }
    }
    yield* fill(0)
  }
}

const DECODERS = new Map<MultibyteSpec, TextDecoder | null>()
const TABLES = new Map<MultibyteSpec, Table>()
const REVERSES = new Map<MultibyteSpec, ReadonlyMap<number, number>>()

/**
 * The platform decoder that seeds a charset's table, built once; null when the
 * platform's `TextDecoder` does not know the charset (a Node built with
 * small-icu), which this host then refuses.
 */
export function hostDecoder(spec: MultibyteSpec): TextDecoder | null {
  let decoder = DECODERS.get(spec)
  if (decoder === undefined) {
    try {
      decoder = new TextDecoder(spec.codec, { fatal: true })
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      logger.debug?.(`iconv: no host decoder for ${spec.codec}: ${String(error)}`)
      decoder = null
    }
    DECODERS.set(spec, decoder)
  }
  return decoder
}

/** The sequence-to-code-point table of a charset `hostDecoder` knows, built once. */
export function multibyteTable(spec: MultibyteSpec): Table {
  const known = TABLES.get(spec)
  if (known !== undefined) return known
  const decoder = hostDecoder(spec)
  if (decoder === null) throw new Error(`no TextDecoder for ${spec.codec}`)
  const table = new Map<number, number>()
  let refused = 0
  let firstError: string | null = null
  for (const seq of sequences(spec.blocks)) {
    const k = key(seq, 0, seq.length)
    if (spec.excluded.some(([low, high]) => low <= k && k <= high)) continue
    let text: string
    try {
      text = decoder.decode(seq)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      refused++
      firstError ??= `${toHex(seq)}: ${String(error)}`
      continue
    }
    const cp = text.codePointAt(0)
    if (cp === undefined || text.length !== (cp > 0xffff ? 2 : 1)) continue
    if (!spec.privateUse && cp >= PRIVATE_USE[0] && cp <= PRIVATE_USE[1]) continue
    table.set(k, cp)
  }
  if (firstError !== null)
    logger.debug?.(
      `iconv: ${spec.codec} table skipped ${String(refused)} undecodable sequences; first: ${firstError}`,
    )
  for (const [k, cp] of spec.remapped) table.set(k, cp)
  TABLES.set(spec, table)
  return table
}

/**
 * The code-point-to-sequence table glibc encodes with, each sequence read
 * big-endian.
 *
 * It is the decode table turned around, single bytes included, plus glibc's
 * one-way entries. No supported charset decodes two sequences to one code
 * point, so the order the entries are added in decides nothing.
 */
export function multibyteReverse(spec: MultibyteSpec): ReadonlyMap<number, number> {
  const known = REVERSES.get(spec)
  if (known !== undefined) return known
  const table = multibyteTable(spec)
  const reverse = new Map<number, number>()
  for (let byte = 0; byte < 0x100; byte++) {
    const [cp, length] = spec.step(Uint8Array.of(byte), 0, table)
    if (cp >= 0 && length === 1 && !reverse.has(cp)) reverse.set(cp, byte)
  }
  for (const [k, cp] of table) if (!reverse.has(cp)) reverse.set(cp, k)
  for (const [cp, k] of spec.oneWay) reverse.set(cp, k)
  REVERSES.set(spec, reverse)
  return reverse
}

/** The GB18030 four-byte sequence of a code point past the BMP, read big-endian. */
function supplementarySequence(cp: number): number {
  let index = cp - 0x10000
  const b4 = index % 10
  index = Math.floor(index / 10)
  const b3 = index % 126
  index = Math.floor(index / 126)
  const b2 = index % 10
  const b1 = Math.floor(index / 10)
  return (((0x90 + b1) << 24) | ((0x30 + b2) << 16) | ((0x81 + b3) << 8) | (0x30 + b4)) >>> 0
}

/**
 * The target side of a multi-byte charset, shared by every input. `put` writes
 * one character at `at` and returns the next offset, or -1 when the charset
 * cannot hold it. Mirrors the Python `MultibyteEncoder`.
 */
export class MultibyteEncoder {
  private readonly reverse: ReadonlyMap<number, number>

  constructor(private readonly spec: MultibyteSpec) {
    this.reverse = multibyteReverse(spec)
  }

  put(cp: number, out: Uint8Array, at: number): number {
    let seq = this.reverse.get(cp)
    if (seq === undefined) {
      if (!this.spec.supplementary || cp < 0x10000) return -1
      seq = supplementarySequence(cp)
    }
    const n = width(seq)
    for (let i = 0; i < n; i++) out[at + i] = (seq >>> (8 * (n - 1 - i))) & 0xff
    return at + n
  }
}
