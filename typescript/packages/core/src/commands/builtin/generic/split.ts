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
import { FlagView } from '../../spec/types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
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

function parseBytesValue(value: string): number {
  const suffix = SPLIT_BYTE_SUFFIXES.find((u) => value.endsWith(u))
  const digits = suffix === undefined ? value : value.slice(0, -suffix.length)
  if (!SPLIT_COUNT_PATTERN.test(digits) || Number.parseInt(digits, 10) === 0) {
    throw new UsageError(`split: invalid number of bytes: '${value}'`, 1)
  }
  return Number.parseInt(digits, 10) * (suffix === undefined ? 1 : (SPLIT_BYTE_UNITS[suffix] ?? 1))
}

function parseLinesValue(value: string): number {
  if (!SPLIT_COUNT_PATTERN.test(value) || Number.parseInt(value, 10) === 0) {
    throw new UsageError(`split: invalid number of lines: '${value}'`, 1)
  }
  return Number.parseInt(value, 10)
}

// A malformed head (the l/r kind letter or the K component) quotes the
// whole spec; a malformed trailing N quotes only N (GNU).
function parseChunksValue(value: string): number {
  const parts = value.split('/')
  if (
    parts
      .slice(0, -1)
      .some((part) => part !== 'l' && part !== 'r' && !SPLIT_COUNT_PATTERN.test(part))
  ) {
    throw new UsageError(`split: invalid number of chunks: '${value}'`, 1)
  }
  const tail = parts.at(-1) ?? value
  if (!SPLIT_COUNT_PATTERN.test(tail) || Number.parseInt(tail, 10) === 0) {
    throw new UsageError(`split: invalid number of chunks: '${tail}'`, 1)
  }
  return Number.parseInt(tail, 10)
}

function parseSuffixLength(value: string): number {
  if (!SPLIT_COUNT_PATTERN.test(value)) {
    throw new UsageError(`split: invalid suffix length: '${value}'`, 1)
  }
  // xstrtoumax overflow: past 2**64 - 1 GNU refuses the width at parse
  // time (byte and line counts saturate instead — a count bigger than the
  // input reads the same either way, but a width this size would be
  // built into a file name).
  if (BigInt(value.trim().replace(/^\+/, '')) > UINTMAX) {
    throw new UsageError(
      `split: invalid suffix length: '${value}': Value too large for defined data type`,
      1,
    )
  }
  return Number.parseInt(value, 10)
}

function parseSuffixStart(value: string, hexMode: boolean, suffixLen: number): number {
  if (!(hexMode ? SPLIT_HEX_DIGITS : SPLIT_DIGITS).test(value)) {
    const kind = hexMode ? 'hexadecimal' : 'numerical'
    throw new UsageError(
      `split: '${value}': invalid start value for ${kind} suffix${SPLIT_TRY_HELP}`,
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
    resourcePath: stripSlash(virtual),
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
  const separator =
    separatorValue === '\\0'
      ? 0
      : typeof separatorValue === 'string'
        ? (ENC.encode(separatorValue)[0] ?? 0x0a)
        : 0x0a
  const linesPerFile =
    linesFlag !== null ? parseLinesValue(linesFlag) : bFlag === null && nFlag === null ? 1000 : 0
  const byteLimit = bFlag !== null ? parseBytesValue(bFlag) : 0
  const nChunks = nFlag !== null ? parseChunksValue(nFlag) : 0
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

  if (nChunks > 0) {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const c of source) {
      chunks.push(c)
      total += c.byteLength
    }
    const allData = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      allData.set(c, offset)
      offset += c.byteLength
    }
    const chunkSize = Math.max(1, Math.ceil(total / nChunks))
    offset = 0
    for (let i = 0; i < nChunks; i++) {
      const part = allData.slice(offset, offset + chunkSize)
      if (part.byteLength === 0) break
      const outPath = outputPath(prefixPath, suffixFn, i, additionalSuffix)
      await write(makePathSpec(outPath), part)
      writes[outPath] = part
      offset += chunkSize
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
