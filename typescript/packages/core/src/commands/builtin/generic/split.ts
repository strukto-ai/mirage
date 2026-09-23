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
import { stripSlash } from '../../../utils/slash.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { quoteText } from '../../quote.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { UsageError } from '../../errors.ts'
import {
  SPLIT_BYTE_SUFFIXES,
  SPLIT_BYTE_UNITS,
  SPLIT_COUNT_PATTERN,
  SPLIT_DIGITS,
  SPLIT_HEX_DIGITS,
  SPLIT_TRY_HELP,
  UINTMAX,
} from '../constants.ts'

const ENC = new TextEncoder()
// The three -n modes: byte chunks, line-preserving chunks, round robin.
type ChunkKind = 'bytes' | 'l' | 'r'
const CHUNK_KIND_PREFIXES: readonly (readonly [string, ChunkKind])[] = [
  ['l/', 'l'],
  ['r/', 'r'],
]

// A parsed -n value: how the input is cut, N, and K of `K/N` (the one
// chunk written to stdout, with no output file created at all; null
// writes every chunk to its own file). Mirrors Python's `ChunkSpec`.
export interface ChunkSpec {
  kind: ChunkKind
  count: number
  only: number | null
}

function parseBytesValue(value: string): number {
  const suffix = SPLIT_BYTE_SUFFIXES.find((u) => value.endsWith(u))
  const digits = suffix === undefined ? value : value.slice(0, -suffix.length)
  if (!SPLIT_COUNT_PATTERN.test(digits) || Number.parseInt(digits, 10) === 0) {
    throw new UsageError(`split: invalid number of bytes: '${quoteText(value)}'`, 1)
  }
  return Number.parseInt(digits, 10) * (suffix === undefined ? 1 : (SPLIT_BYTE_UNITS[suffix] ?? 1))
}

function parseLinesValue(value: string): number {
  if (!SPLIT_COUNT_PATTERN.test(value) || Number.parseInt(value, 10) === 0) {
    throw new UsageError(`split: invalid number of lines: '${quoteText(value)}'`, 1)
  }
  return Number.parseInt(value, 10)
}

// GNU strips ONE leading `l/` or `r/` and then cuts what is left at its
// FIRST slash into K and N: a K it cannot parse names the whole remainder,
// and every other refusal names N, which is the rest of the spec however
// many slashes that still holds. Measured on coreutils 9.4: `l/xé/4` names
// `xé/4`, `2/3/4` and `l/2/3/4` name `3/4`, `l//4` names `/4`, `r/l/4`
// names `l/4`, and `+l/2` and `x/3` name themselves because neither
// carries a kind prefix. mirage used to name the whole spec for every
// malformed head and credited that to 9.7; 9.4 disagrees, and so does the
// accepted set -- a third component is N's problem, not a head component.
// GNU strips ONE leading `l/` or `r/` and then cuts what is left at its
// FIRST slash into K and N: a K it cannot parse names the whole remainder,
// and every other refusal names N. A K that parses but is 0 or past N is
// its own refusal, `invalid chunk number`, checked after N (coreutils 9.7:
// `4/3` and `0/3` name K, `3/0` names N). Mirrors `parse_chunks_value`.
export function parseChunksValue(value: string): ChunkSpec {
  let kind: ChunkKind = 'bytes'
  let spec = value
  for (const [prefix, prefixedKind] of CHUNK_KIND_PREFIXES) {
    if (value.startsWith(prefix)) {
      kind = prefixedKind
      spec = value.slice(prefix.length)
      break
    }
  }
  const slash = spec.indexOf('/')
  const head = slash >= 0 ? spec.slice(0, slash) : spec
  if (slash >= 0 && !SPLIT_COUNT_PATTERN.test(head)) {
    throw new UsageError(`split: invalid number of chunks: '${quoteText(spec)}'`, 1)
  }
  const countRaw = slash >= 0 ? spec.slice(slash + 1) : spec
  if (!SPLIT_COUNT_PATTERN.test(countRaw) || Number.parseInt(countRaw, 10) === 0) {
    throw new UsageError(`split: invalid number of chunks: '${quoteText(countRaw)}'`, 1)
  }
  const count = Number.parseInt(countRaw, 10)
  if (!Number.isSafeInteger(count)) {
    // Deliberate divergence: GNU saturates a count past uintmax and then
    // creates files without end. A count past 2^53 cannot even be
    // counted here, so it is refused in the same words as a malformed one.
    throw new UsageError(`split: invalid number of chunks: '${quoteText(countRaw)}'`, 1)
  }
  let only: number | null = null
  if (slash >= 0) {
    only = Number.parseInt(head, 10)
    if (only === 0 || only > count) {
      throw new UsageError(`split: invalid chunk number: '${quoteText(head)}'`, 1)
    }
  }
  return { kind, count, only }
}

function parseSuffixLength(value: string): number {
  if (!SPLIT_COUNT_PATTERN.test(value)) {
    throw new UsageError(`split: invalid suffix length: '${quoteText(value)}'`, 1)
  }
  // xstrtoumax overflow: past 2**64 - 1 GNU refuses the width at parse
  // time (byte and line counts saturate instead — a count bigger than the
  // input reads the same either way, but a width this size would be
  // built into a file name).
  if (BigInt(value.trim().replace(/^\+/, '')) > UINTMAX) {
    throw new UsageError(
      `split: invalid suffix length: '${quoteText(value)}': ` +
        'Value too large for defined data type',
      1,
    )
  }
  return Number.parseInt(value, 10)
}

// The refused value is named through gnulib's quote() like every other word
// split reports, and it comes FIRST in this clause where the four count
// clauses put it last (measured on coreutils 9.4:
// `split: 'x\303\251': invalid start value for numerical suffix`).
// Hex digits are lower case only, as GNU's own suffixes are:
// `--hex-suffixes=A` is refused (coreutils 9.7). An empty value
// (`--numeric-suffixes=`) is a start of 0 that still pins the width, since
// GNU checks `strspn` over an empty string and keeps the pointer; only an
// absent value auto-lengthens.
function parseSuffixStart(value: string, hexMode: boolean, suffixLen: number): number {
  if (value === '') return 0
  if (!(hexMode ? SPLIT_HEX_DIGITS : SPLIT_DIGITS).test(value)) {
    const kind = hexMode ? 'hexadecimal' : 'numerical'
    throw new UsageError(
      `split: '${quoteText(value)}': invalid start value for ${kind} suffix${SPLIT_TRY_HELP}`,
      1,
    )
  }
  const start = Number.parseInt(value, hexMode ? 16 : 10)
  if (start.toString(hexMode ? 16 : 10).length > suffixLen) {
    throw new UsageError(
      `split: numerical suffix start value is too large for the suffix length${SPLIT_TRY_HELP}`,
      1,
    )
  }
  return start
}

// GNU reads -t as one byte and refuses every other length rather than
// truncating to the first: an empty value is an empty record separator and
// anything longer is a multi-character one, with the two-character spelling
// `\0` carved out as the only way to write a NUL on a command line. The
// length is counted in bytes, so a lone non-ASCII character is
// multi-character too (pinned against coreutils 9.7). Deliberate
// divergence, matching truncate: GNU's quotearg escapes control characters
// in the message and mirage quotes the raw value. Not covered: GNU also
// refuses two -t flags naming different characters, which needs a
// list-valued flag the spec does not have.
function parseSeparator(value: string | undefined): number {
  if (value === undefined) return 0x0a
  if (value === '\\0') return 0
  const encoded = ENC.encode(value)
  if (encoded.byteLength === 0) throw new UsageError('split: empty record separator', 1)
  if (encoded.byteLength > 1) {
    throw new UsageError(`split: multi-character separator '${value}'`, 1)
  }
  return encoded[0] ?? 0x0a
}

// Cut `data` into `count` byte chunks the way GNU sizes them: `size /
// count` bytes each, with the remainder spread one byte at a time over the
// FIRST chunks (7 bytes in 3 are 3, 2, 2 on coreutils 9.7), and an input
// shorter than the count leaves the tail chunks empty rather than absent.
// Byte offset where chunk `index` (1-based) ends: GNU sizes chunks `base`
// bytes each with the remainder spread one byte at a time over the FIRST
// chunks, so the end is a closed form rather than a table of N prefix sums.
function chunkEnd(index: number, base: number, rem: number): number {
  return base * index + Math.min(index, rem)
}

// The byte chunks of `data` in order, the way GNU sizes them: `size / count`
// bytes each, with the remainder spread one byte at a time over the FIRST
// chunks (7 bytes in 3 are 3, 2, 2 on coreutils 9.7). Stops once the input
// is used up, because every chunk after that is empty; `chunkParts` pads and
// `chunkAt` reads past the end, so a huge N never costs N slices.
function* byteChunks(data: Uint8Array, count: number): Generator<Uint8Array> {
  const base = Math.floor(data.byteLength / count)
  const rem = data.byteLength % count
  let pos = 0
  for (let index = 0; index < count; index++) {
    if (pos >= data.byteLength) return
    const size = base + (index < rem ? 1 : 0)
    yield data.slice(pos, pos + size)
    pos += size
  }
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

// The line chunks of `data` in order, no record cut: GNU's
// `lines_chunk_split`. The byte boundaries are those of `byteChunks` over
// `max(size, count)`, and a chunk runs to the first terminator at or after
// its own last byte, so a record that straddles a boundary goes whole to
// the chunk it started in. A record long enough to cover a whole later
// chunk leaves that chunk empty, and a chunk that begins exactly where the
// previous one ended takes the next record. Measured on coreutils 9.7
// (`-n l/7` over five 6-byte lines is line1, line2, line3, empty, line4,
// line5, empty). Stops once the input is used up, like `byteChunks`.
// Mirrors `_line_chunks`.
function* lineChunks(data: Uint8Array, count: number, eol: number): Generator<Uint8Array> {
  const size = Math.max(data.byteLength, count)
  const base = Math.floor(size / count)
  const rem = size % count
  let buf: Uint8Array[] = []
  let pos = 0
  let chunk = 0
  while (pos < data.byteLength && chunk < count) {
    const start = Math.max(pos, chunkEnd(chunk + 1, base, rem) - 1)
    const found = start < data.byteLength ? data.indexOf(eol, start) : -1
    const end = found >= 0 ? found + 1 : data.byteLength
    let terminated = found >= 0
    buf.push(data.slice(pos, end))
    pos = end
    while (terminated || chunkEnd(chunk + 1, base, rem) <= pos) {
      if (!terminated && pos >= data.byteLength) break
      yield concatParts(buf)
      buf = []
      chunk += 1
      if (chunk >= count) break
      if (chunkEnd(chunk + 1, base, rem) > pos) terminated = false
    }
  }
  if (chunk < count) yield concatParts(buf)
}

// The records of `data`, a final unterminated one included.
function records(data: Uint8Array, eol: number): Uint8Array[] {
  const out: Uint8Array[] = []
  let pos = 0
  while (pos < data.byteLength) {
    const found = data.indexOf(eol, pos)
    const end = found >= 0 ? found + 1 : data.byteLength
    out.push(data.slice(pos, end))
    pos = end
  }
  return out
}

// The chunks of `data` dealt record by record in turn: chunk k holds every
// count-th record from the k-th, and a chunk past the last record is empty,
// so the walk stops there.
function* roundRobinChunks(data: Uint8Array, count: number, eol: number): Generator<Uint8Array> {
  const dealt = records(data, eol)
  const filled = Math.min(count, dealt.length)
  for (let index = 0; index < filled; index++) {
    const own: Uint8Array[] = []
    for (let at = index; at < dealt.length; at += count) own.push(dealt[at] ?? new Uint8Array(0))
    yield concatParts(own)
  }
}

function cut(data: Uint8Array, chunks: ChunkSpec, separator: number): Generator<Uint8Array> {
  if (chunks.kind === 'l') return lineChunks(data, chunks.count, separator)
  if (chunks.kind === 'r') return roundRobinChunks(data, chunks.count, separator)
  return byteChunks(data, chunks.count)
}

// Every chunk of `data` under one -n spec, in order: exactly N chunks, the
// empty tail included, one at a time, so N files never mean N chunks held
// at once. Mirrors `chunk_parts`.
export function* chunkParts(
  data: Uint8Array,
  chunks: ChunkSpec,
  separator: number,
): Generator<Uint8Array> {
  let produced = 0
  for (const part of cut(data, chunks, separator)) {
    yield part
    produced += 1
  }
  for (; produced < chunks.count; produced++) yield new Uint8Array(0)
}

// Chunk `index` (1-based) of `data` under one -n spec. `K/N` wants one
// chunk, so only the chunks before it are cut, and a K past the input's
// last byte is empty at no cost per skipped chunk (`-n 2/1000000000` over
// 8 bytes is `b`, instant in GNU). Mirrors `chunk_at`.
export function chunkAt(
  data: Uint8Array,
  chunks: ChunkSpec,
  separator: number,
  index: number,
): Uint8Array {
  let seen = 0
  for (const part of cut(data, chunks, separator)) {
    seen += 1
    if (seen === index) return part
  }
  return new Uint8Array(0)
}

const ALPHA_SUFFIXES = 'abcdefghijklmnopqrstuvwxyz'
const NUMERIC_SUFFIXES = '0123456789'
const HEX_SUFFIXES = '0123456789abcdef'

function toBase(value: number, alphabet: string, width: number): string {
  const base = alphabet.length
  const chars: string[] = []
  let v = value
  for (let i = 0; i < width; i++) {
    chars.push(alphabet[v % base] ?? '')
    v = Math.floor(v / base)
  }
  return chars.reverse().join('')
}

// GNU's next_file_name: with no explicit width and no explicit start value
// the suffix auto-lengthens, reserving the last alphabet character as a
// prefix — aa..yz, then zaaa..zyzz, then zzaaaa.. (00..89 then 9000..9899
// then 990000.. for -d); band k holds (B-1)*B**(k+1) names behind k reserved
// characters. An explicit -a width or a --numeric/hex-suffixes start value
// pins the width, and running past B**width is GNU's exhaustion error with
// the chunks already written kept (pinned against coreutils 9.7).
// Deliberate divergence: GNU with a hex start whose leading digit is the
// reserved 'f' (--hex-suffixes=f0) walks past its alphabet and names files
// with non-hex characters; mirage exhausts cleanly at B**width.
function suffixNamer(
  alphabet: string,
  auto: boolean,
  width: number,
  start: number,
): (index: number) => string {
  const base = alphabet.length
  return (index: number): string => {
    if (auto) {
      let band = 0
      let capacity = (base - 1) * base
      let rest = index
      while (rest >= capacity) {
        rest -= capacity
        band += 1
        capacity *= base
      }
      return (alphabet[base - 1] ?? '').repeat(band) + toBase(rest, alphabet, band + 2)
    }
    const value = start + index
    if (value >= base ** width) {
      throw new UsageError('split: output file suffixes exhausted', 1)
    }
    return toBase(value, alphabet, width)
  }
}

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: stripSlash(virtual),
    resolved: true,
  })
}

function outputPath(
  prefix: string,
  suffix: (index: number) => string,
  index: number,
  additional: string,
): string {
  return prefix + suffix(index) + additional
}

function joinLines(lines: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const l of lines) total += l.byteLength + 1
  const out = new Uint8Array(total)
  let offset = 0
  for (const l of lines) {
    out.set(l, offset)
    offset += l.byteLength
    out[offset] = 0x0a
    offset += 1
  }
  return out
}

async function* recordIterator(
  source: AsyncIterable<Uint8Array>,
  separator: number,
): AsyncIterable<Uint8Array> {
  let pending = new Uint8Array(0)
  for await (const chunk of source) {
    const merged = new Uint8Array(pending.byteLength + chunk.byteLength)
    merged.set(pending)
    merged.set(chunk, pending.byteLength)
    let start = 0
    for (let index = 0; index < merged.byteLength; index++) {
      if (merged[index] === separator) {
        yield merged.slice(start, index)
        start = index + 1
      }
    }
    pending = merged.slice(start)
  }
  if (pending.byteLength > 0) yield pending
}

function joinRecords(records: readonly Uint8Array[], separator: number): Uint8Array {
  if (separator === 0x0a) return joinLines(records)
  let total = records.length
  for (const record of records) total += record.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const record of records) {
    out.set(record, offset)
    offset += record.byteLength
    out[offset] = separator
    offset += 1
  }
  return out
}

export async function splitGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('split'))
  if (paths.length > 2) throw extraOperandError(CommandName.SPLIT, paths[2]?.rawPath ?? '')
  const prefixPath = paths.length >= 2 && paths[1] !== undefined ? paths[1].mountPath : 'x'
  const linesValue = fl.asStr('lines')
  const bytesValue = fl.asStr('bytes')
  const numberValue = fl.asStr('number')
  const lengthValue = fl.asStr('suffix_length')
  const numericValue = fl.raw('numeric_suffixes')
  const hexValue = fl.raw('hex_suffixes')
  const separatorValue = fl.asStr('separator')
  const linesFlag = typeof linesValue === 'string' ? linesValue : null
  const bFlag = typeof bytesValue === 'string' ? bytesValue : null
  const nFlag = typeof numberValue === 'string' ? numberValue : null
  const aFlag = typeof lengthValue === 'string' ? lengthValue : null
  const dFlag = numericValue !== undefined
  const xFlag = hexValue !== undefined
  const suffixLenRaw = aFlag !== null ? parseSuffixLength(aFlag) : 2
  // GNU reads an explicit `-a 0` as "revert to auto width": names start at
  // the default length of 2 and keep auto-lengthening.
  const suffixLen = suffixLenRaw === 0 ? 2 : suffixLenRaw
  const suffixAuto =
    (aFlag === null || suffixLenRaw === 0) &&
    typeof numericValue !== 'string' &&
    typeof hexValue !== 'string'
  const suffixStart =
    typeof numericValue === 'string'
      ? parseSuffixStart(numericValue, false, suffixLen)
      : typeof hexValue === 'string'
        ? parseSuffixStart(hexValue, true, suffixLen)
        : 0
  const additionalSuffix = fl.asStr('additional_suffix') ?? ''
  const separator = parseSeparator(separatorValue)
  const linesPerFile =
    linesFlag !== null ? parseLinesValue(linesFlag) : bFlag === null && nFlag === null ? 1000 : 0
  const byteLimit = bFlag !== null ? parseBytesValue(bFlag) : 0
  const chunks = nFlag !== null ? parseChunksValue(nFlag) : null
  const suffixFn = suffixNamer(
    xFlag ? HEX_SUFFIXES : dFlag ? NUMERIC_SUFFIXES : ALPHA_SUFFIXES,
    suffixAuto,
    suffixLen,
    suffixStart,
  )

  let source: AsyncIterable<Uint8Array>
  const first = paths[0]
  if (first !== undefined) {
    source = stream(first)
  } else {
    source = resolveSource(opts.stdin)
  }

  const writes: Record<string, Uint8Array> = {}
  let fileIdx = 0

  if (chunks !== null) {
    const gathered: Uint8Array[] = []
    for await (const c of source) gathered.push(c)
    const all = concatParts(gathered)
    if (chunks.only !== null) {
      // `K/N` writes the one chunk to stdout and no file at all.
      return [chunkAt(all, chunks, separator, chunks.only), new IOResult()]
    }
    // Every chunk gets its file, an empty one included: GNU creates N files
    // for `-n N` however short the input is.
    let i = 0
    for (const part of chunkParts(all, chunks, separator)) {
      const outPath = outputPath(prefixPath, suffixFn, i, additionalSuffix)
      i += 1
      await write(makePathSpec(outPath), part)
      writes[outPath] = part
    }
  } else if (byteLimit > 0) {
    let buf = new Uint8Array(0)
    for await (const c of source) {
      const merged = new Uint8Array(buf.byteLength + c.byteLength)
      merged.set(buf, 0)
      merged.set(c, buf.byteLength)
      buf = merged
      while (buf.byteLength >= byteLimit) {
        const outPath = outputPath(prefixPath, suffixFn, fileIdx, additionalSuffix)
        const data = buf.slice(0, byteLimit)
        await write(makePathSpec(outPath), data)
        writes[outPath] = data
        buf = buf.slice(byteLimit)
        fileIdx += 1
      }
    }
    if (buf.byteLength > 0) {
      const outPath = outputPath(prefixPath, suffixFn, fileIdx, additionalSuffix)
      await write(makePathSpec(outPath), buf)
      writes[outPath] = buf
    }
  } else {
    const lineBuf: Uint8Array[] = []
    const iter =
      separator === 0x0a ? new AsyncLineIterator(source) : recordIterator(source, separator)
    for await (const line of iter) {
      lineBuf.push(line)
      if (lineBuf.length >= linesPerFile) {
        const outPath = outputPath(prefixPath, suffixFn, fileIdx, additionalSuffix)
        const data = joinRecords(lineBuf, separator)
        await write(makePathSpec(outPath), data)
        writes[outPath] = data
        lineBuf.length = 0
        fileIdx += 1
      }
    }
    if (lineBuf.length > 0) {
      const outPath = outputPath(prefixPath, suffixFn, fileIdx, additionalSuffix)
      const data = joinRecords(lineBuf, separator)
      await write(makePathSpec(outPath), data)
      writes[outPath] = data
    }
  }
  return [null, new IOResult({ writes })]
}
