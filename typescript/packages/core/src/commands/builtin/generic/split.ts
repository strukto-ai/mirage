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
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { ByteWriter } from '../../../io/writer.ts'
import { RecordSpool } from '../../../io/record_spool.ts'
import { closeQuietly, OutputStream, rechunk } from '../../../io/stream.ts'
import { CHUNK_SIZE } from '../../../io/cooperative.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
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
// multi-character too, and the refused value is escaped like every other
// word split quotes (pinned against coreutils 9.7). Not covered: GNU also
// refuses two -t flags naming different characters, which needs a
// list-valued flag the spec does not have.
function parseSeparator(value: string | undefined): number {
  if (value === undefined) return 0x0a
  if (value === '\\0') return 0
  const encoded = ENC.encode(value)
  if (encoded.byteLength === 0) throw new UsageError('split: empty record separator', 1)
  if (encoded.byteLength > 1) {
    throw new UsageError(`split: multi-character separator '${quoteText(value)}'`, 1)
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

async function* numberParts(
  records: RecordSpool,
  spec: ChunkSpec,
  separator: number,
): AsyncGenerator<ByteSource> {
  const spool = records.data
  const count = spec.count
  if (spec.kind === 'bytes' || spec.kind === 'r') {
    const base = Math.floor(spool.size / count)
    const rem = spool.size % count
    for (
      let index = spec.only === null ? 0 : spec.only - 1;
      index < (spec.only ?? count);
      index++
    ) {
      const start = chunkEnd(index, base, rem)
      yield spec.kind === 'bytes'
        ? spool.stream(start, chunkEnd(index + 1, base, rem) - start)
        : rechunk(roundRobinSource(records, index, count), CHUNK_SIZE)
    }
    return
  }
  const base = Math.floor(Math.max(spool.size, count) / count)
  const rem = Math.max(spool.size, count) % count
  let index = 0
  let pos = 0
  let record = 0
  while (pos < spool.size && index < count) {
    const threshold = Math.max(pos, chunkEnd(index + 1, base, rem) - 1)
    while (record < records.count) {
      const [start, size] = await records.window(record)
      if (start + size > threshold) break
      record++
    }
    const [offset, size] = record >= records.count ? [spool.size, 0] : await records.window(record)
    const end = offset + size
    let terminated = end > 0 && (await spool.read(end - 1, 1))[0] === separator
    let start = pos
    pos = end
    while (terminated || chunkEnd(index + 1, base, rem) <= pos) {
      if (!terminated && pos >= spool.size) break
      if (spec.only === null || spec.only === index + 1) {
        yield spool.stream(start, pos - start)
        if (spec.only !== null) return
      }
      start = pos
      index++
      if (index >= count) break
      if (chunkEnd(index + 1, base, rem) > pos) terminated = false
    }
    if (pos >= spool.size && index < count) {
      if (spec.only === null || spec.only === index + 1) {
        yield spool.stream(start, pos - start)
        if (spec.only !== null) return
      }
      index++
    }
  }
  if (spec.only !== null) yield new Uint8Array()
  else for (; index < count; index++) yield new Uint8Array()
}

async function* roundRobinSource(
  records: RecordSpool,
  index: number,
  count: number,
): AsyncGenerator<Uint8Array> {
  for (let record = index; record < records.count; record += count) yield* records.stream(record)
}

async function* selectedNumberPart(
  records: RecordSpool,
  spec: ChunkSpec,
  separator: number,
): AsyncGenerator<Uint8Array> {
  for await (const part of numberParts(records, spec, separator)) {
    if (part instanceof Uint8Array) {
      if (part.length > 0) yield part
    } else yield* part
  }
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

function prefixVirtualOf(prefix: PathSpec): string {
  if (prefix.rawPath === '' || prefix.rawPath.endsWith('/')) {
    return `${rstripSlash(prefix.virtual)}/`
  }
  return prefix.virtual
}

export async function splitGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('split'))
  if (paths.length > 2) throw extraOperandError(CommandName.SPLIT, paths[2]?.rawPath ?? '')
  // An output is the prefix operand, or `x` in the working directory, plus
  // its suffix, wherever the input lives: GNU writes `xaa` to the cwd, names
  // it as it formed it (`split: xaa`, `split: /ro/preaa`), and stops at the
  // first one it cannot create. Mirrors split.py.
  const prefixOperand = paths.length >= 2 ? paths[1] : undefined
  const prefixVirtual =
    prefixOperand !== undefined ? prefixVirtualOf(prefixOperand) : resolvePath('x', opts.cwd)
  const typedPrefix = prefixOperand?.rawPath ?? 'x'
  const mountPrefix = opts.mountPrefix ?? ''
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
  // `-` is stdin. /dev/stdin would run split on the /dev mount, which is
  // where its pieces would land, so it stays a path.
  const first = paths[0]
  if (first !== undefined && first.rawPath !== '-') {
    source = stream(first)
  } else {
    source = resolveSource(opts.stdin)
  }

  let fileIdx = 0
  const emit = async (name: string, data: ByteSource): Promise<void> => {
    const virtual = prefixVirtual + name
    const spec = PathSpec.fromStrPath(virtual, mountKey(virtual, mountPrefix))
    try {
      await write(spec, data)
    } catch (err) {
      if (!isFsError(err)) throw err
      throw new UsageError(`split: ${typedPrefix + name}: ${String(fsStrerror(err))}`, 1)
    }
  }

  if (chunks !== null) {
    const records = new RecordSpool()
    let handedOff = false
    try {
      await records.data.fill(source)
      if (chunks.kind !== 'bytes') await records.indexDelimited(separator)
      if (chunks.only !== null) {
        const output = new OutputStream(selectedNumberPart(records, chunks, separator), () =>
          records.close(),
        )
        handedOff = true
        return [output, new IOResult()]
      }
      let i = 0
      for await (const part of numberParts(records, chunks, separator)) {
        await emit(suffixFn(i++) + additionalSuffix, part)
      }
    } finally {
      if (!handedOff) await records.close()
    }
  } else {
    let writer: ByteWriter | null = null
    let used = 0
    const open = (): ByteWriter => {
      const name = suffixFn(fileIdx) + additionalSuffix
      return new ByteWriter((data) => emit(name, data))
    }
    try {
      if (byteLimit > 0) {
        for await (const chunk of source) {
          let offset = 0
          while (offset < chunk.byteLength) {
            writer ??= open()
            const count = Math.min(byteLimit - used, chunk.byteLength - offset)
            await writer.write(chunk.subarray(offset, offset + count))
            offset += count
            used += count
            if (used === byteLimit) {
              await writer.finish()
              writer = null
              used = 0
              fileIdx++
            }
          }
        }
      } else {
        const reader = new AsyncLineIterator(source)
        try {
          for (;;) {
            const [line, terminated] = await reader.readUntil(separator, opts.signal)
            if (line.byteLength === 0 && !terminated) break
            writer ??= open()
            await writer.write(line)
            if (terminated) await writer.write(new Uint8Array([separator]))
            if (++used === linesPerFile) {
              await writer.finish()
              writer = null
              used = 0
              fileIdx++
            }
          }
        } finally {
          await reader.discard()
        }
      }
      if (writer !== null) {
        await writer.finish()
        writer = null
      }
    } finally {
      if (writer !== null) await writer.abort()
      await closeQuietly(source)
    }
  }
  return [null, new IOResult()]
}
