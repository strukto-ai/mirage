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

import { closeQuietly, primeStream } from '../../../io/stream.ts'

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { concat } from '../../../utils/bytes.ts'
import { chunks } from '../../../io/cooperative.ts'
import type { ByteSource } from '../../../io/types.ts'
import { parseBase0 } from '../utils/size_suffix.ts'
import { singleChunk } from '../utils/operands.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isEnoent, isFsError } from '../../../errors/fs.ts'
import type { CommandOpts } from '../../config.ts'
import { isStdin, resolveSource, stdinStream } from '../utils/stream.ts'
import { asyncChain } from '../../../io/stream.ts'
import { extraOperandError, readFailExitCode } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// xxd's exit for an OUTFILE it cannot open, for an INFILE it cannot seek
// where -s says, and for a dump that seeks backwards on a stream (vim's xxd
// 2024-12-07).
const OPEN_OUTPUT_EXIT = 3
const CANNOT_SEEK_EXIT = 4
const SEEK_BACK_EXIT = 5
const CANNOT_SEEK = 'xxd: Sorry, cannot seek.\n'
// A number as C's strtol reads it at base 0: optional space and sign, then
// hex after 0x, octal after a bare 0, decimal otherwise; anything after the
// digits is ignored.
const STRTOL_PATTERN = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/
// The most NUL bytes one chunk carries when a dump's offset skips ahead.
const GAP_CHUNK = 65536
// What a plain dump's bytes decode to, and the ones it skips.
const HEX_DIGITS = Int8Array.from({ length: 256 }, (_, c) =>
  /[0-9a-fA-F]/.test(String.fromCharCode(c)) ? Number.parseInt(String.fromCharCode(c), 16) : -1,
)
const PLAIN_BLANKS: ReadonlySet<number> = new Set([0x20, 0x09, 0x0d, 0x0a])

function padLeft(s: string, width: number, ch = ' '): string {
  return s.length >= width ? s : ch.repeat(width - s.length) + s
}

function padRight(s: string, width: number, ch = ' '): string {
  return s.length >= width ? s : s + ch.repeat(width - s.length)
}

function hexByte(b: number, uppercase: boolean): string {
  const h = b.toString(16).padStart(2, '0')
  return uppercase ? h.toUpperCase() : h
}

function hexOffset(offset: number, uppercase: boolean): string {
  const h = offset.toString(16).padStart(8, '0')
  return uppercase ? h.toUpperCase() : h
}

async function* xxdDumpStream(
  source: AsyncIterable<Uint8Array>,
  cols: number,
  group: number,
  uppercase: boolean,
  base = 0,
): AsyncIterable<Uint8Array> {
  let offset = base
  let leftover = new Uint8Array(0)
  const hexColumnWidth = cols * 2 + Math.floor(cols / group) - 1
  const emitRow = (row: Uint8Array): Uint8Array => {
    const hexParts: string[] = []
    for (let g = 0; g < row.byteLength; g += group) {
      let seg = ''
      const end = Math.min(g + group, row.byteLength)
      for (let k = g; k < end; k++) seg += hexByte(row[k] ?? 0, uppercase)
      hexParts.push(seg)
    }
    const hexPart = hexParts.join(' ')
    let asciiPart = ''
    for (const b of row) asciiPart += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'
    const line = `${hexOffset(offset, uppercase)}: ${padRight(hexPart, hexColumnWidth)}  ${asciiPart}\n`
    return ENC.encode(line)
  }
  for await (const chunk of source) {
    const merged = new Uint8Array(leftover.byteLength + chunk.byteLength)
    merged.set(leftover, 0)
    merged.set(chunk, leftover.byteLength)
    let i = 0
    while (i + cols <= merged.byteLength) {
      yield emitRow(merged.subarray(i, i + cols))
      offset += cols
      i += cols
    }
    leftover = merged.subarray(i)
  }
  if (leftover.byteLength > 0) {
    yield emitRow(leftover)
  }
}

async function* xxdPlainStream(
  source: AsyncIterable<Uint8Array>,
  uppercase: boolean,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    let hex = ''
    for (const b of chunk) hex += hexByte(b, uppercase)
    yield ENC.encode(hex)
  }
  yield ENC.encode('\n')
}

/**
 * The bytes the hex digit pairs at the start of `digits` spell: xxd stops at
 * the first character that is not a hex digit and drops a digit left without
 * its pair. Mirrors Python's _unhex.
 */
function unhex(digits: string): Uint8Array {
  const run = /^[0-9A-Fa-f]*/.exec(digits)?.[0] ?? ''
  const out = new Uint8Array(Math.floor(run.length / 2))
  for (let i = 0; i < out.byteLength; i++) out[i] = Number.parseInt(run.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * One hexdump line as the offset its bytes go to and the bytes. A line
 * without an offset continues where the last one ended (null); a line whose
 * offset is not hex decodes to nothing, as xxd skips it. Mirrors Python's
 * _reverse_line.
 */
function reverseLine(raw: string): [number | null, Uint8Array] {
  let line = raw
  let offset: number | null = null
  const colon = line.indexOf(':')
  if (colon !== -1) {
    const head = line.slice(0, colon).trim()
    if (!/^[0-9a-fA-F]+$/.test(head)) return [null, new Uint8Array(0)]
    offset = Number.parseInt(head, 16)
    line = line.slice(colon + 1)
  }
  const twoSpace = line.search(/ {2,}/)
  return [offset, unhex((twoSpace === -1 ? line : line.slice(0, twoSpace)).replace(/ /g, ''))]
}

/**
 * Decode a hexdump into runs of bytes and the offsets they go to. Mirrors
 * Python's _reverse_runs.
 */
async function* reverseRuns(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<[number | null, Uint8Array]> {
  const reader = new AsyncLineIterator(source)
  let first = true
  try {
    for (;;) {
      const [raw, ended] = await reader.readUntil(0x0a)
      if (raw.length === 0 && !ended) return
      const line = DEC.decode(raw)
      if (first && line !== '' && !line.includes(':')) {
        const lines = [line]
        let more = ended
        while (more) {
          const [rest, next] = await reader.readUntil(0x0a)
          lines.push(DEC.decode(rest))
          more = next
        }
        if (lines.some((row) => row.includes(':'))) {
          for (const row of lines) if (row !== '') yield reverseLine(row)
        } else {
          const digits = lines.map((row) => /^[0-9A-Fa-f\s]*/.exec(row)?.[0] ?? '').join('')
          yield [null, unhex(digits.replace(/\s+/g, ''))]
        }
        return
      }
      if (line !== '') {
        first = false
        yield reverseLine(line)
      }
    }
  } finally {
    await reader.discard()
  }
}

/**
 * Decode a plain (-p) hexdump as it arrives, as xxd 2024-12-07 does. Space,
 * tab, CR and LF never count, so two digits make a byte across them and
 * across lines. Any other byte is ignored before the first digit and after a
 * skipped line; past that it drops a digit left without its pair, and a run
 * of them skips the rest of the line. Mirrors Python's _plain_runs.
 */
async function* plainRuns(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<[number | null, Uint8Array]> {
  let [high, low, lead, skip] = [0, -1, true, false]
  for await (const part of chunks(source)) {
    const out: number[] = []
    for (const c of part) {
      if (skip) {
        if (c === 0x0a) [skip, lead] = [false, true]
        continue
      }
      if (PLAIN_BLANKS.has(c)) continue
      const before = high
      high = low
      low = HEX_DIGITS[c] ?? -1
      if (low < 0 && lead) continue
      lead = false
      if (high >= 0 && low >= 0) {
        out.push((high << 4) | low)
        low = -1
      } else if (low < 0 && high < 0 && before < 0) skip = true
    }
    if (out.length > 0) yield [null, Uint8Array.from(out)]
  }
}

/**
 * Revert a hexdump onto a stream, which can only move forward. An offset
 * past the bytes written so far is reached with NUL bytes; one before them
 * cannot be, so the stream stops there with xxd's refusal. Deliberate
 * divergence: stdout is a stream here even when the line redirects it to a
 * file, which xxd would seek. Mirrors Python's _xxd_reverse_stream.
 */
async function* xxdReverseStream(
  source: AsyncIterable<Uint8Array>,
  io: IOResult | null = null,
  plain = false,
): AsyncIterable<Uint8Array> {
  let position = 0
  for await (const [offset, data] of (plain ? plainRuns : reverseRuns)(source)) {
    if (data.byteLength === 0) continue
    if (offset !== null && offset < position) {
      if (io !== null) {
        io.exitCode = SEEK_BACK_EXIT
        io.stderr = ENC.encode('xxd: Sorry, cannot seek backwards.\n')
      }
      return
    }
    while (offset !== null && position < offset) {
      const gap = Math.min(offset - position, GAP_CHUNK)
      yield new Uint8Array(gap)
      position += gap
    }
    yield data
    position += data.byteLength
  }
}

/**
 * Revert a hexdump into the stretches xxd writes into OUTFILE. Each run lands
 * at its offset, or where the last one ended; runs that meet join one
 * stretch, so a whole dump is one write at 0. Mirrors Python's
 * _reverse_segments.
 */
async function reverseSegments(
  source: AsyncIterable<Uint8Array>,
  plain: boolean,
): Promise<[number, Uint8Array][]> {
  const segments: { start: number; end: number; parts: Uint8Array[] }[] = []
  let position = 0
  for await (const [offset, data] of (plain ? plainRuns : reverseRuns)(source)) {
    if (data.byteLength === 0) continue
    if (offset !== null) position = offset
    const last = segments.at(-1)
    if (last?.end === position) {
      last.parts.push(data)
      last.end += data.byteLength
    } else {
      segments.push({ start: position, end: position + data.byteLength, parts: [data] })
    }
    position += data.byteLength
  }
  return segments.map(({ start, parts }): [number, Uint8Array] => [start, concat(parts)])
}

/**
 * A file's bytes with the stretches written into it, as pwrite does: the
 * bytes around each stretch stay, and the file grows only where one reaches
 * past its end, padded with NUL. Mirrors Python's _patched.
 */
function patched(existing: Uint8Array, segments: [number, Uint8Array][]): Uint8Array {
  let buf = existing.slice()
  for (const [start, data] of segments) {
    const end = start + data.byteLength
    if (end > buf.byteLength) {
      const grown = new Uint8Array(end)
      grown.set(buf, 0)
      buf = grown
    }
    buf.set(data, start)
  }
  return buf
}

void padLeft

/** `text` as C's `strtol(text, NULL, 0)` reads it: 0 when it holds no number.
 * Mirrors Python's strtol. */
export function strtol(text: string): number {
  const match = STRTOL_PATTERN.exec(text)
  if (match === null) return 0
  const value = Number(parseBase0(match[2] ?? '0'))
  return match[1] === '-' ? -value : value
}

/** `-s` as xxd reads it: `[+][-]offset`. `relative` (`+`) seeks from where
 * INFILE stands, which is its start here; `back` (`-`) seeks back from its
 * end. Mirrors Python's XxdSeek. */
export interface XxdSeek {
  readonly offset: number
  readonly relative: boolean
  readonly back: boolean
}

/** The `-l` operand: null for none, and a negative count too, which xxd reads
 * as no limit; `0` (or no number) dumps nothing. Mirrors Python's
 * parse_limit. */
export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const limit = strtol(raw)
  return limit < 0 ? null : limit
}

/** The `-s` operand. Mirrors Python's parse_seek. */
export function parseSeek(raw: string): XxdSeek {
  const relative = raw.startsWith('+')
  const rest = relative ? raw.slice(1) : raw
  const back = rest.startsWith('-')
  return { offset: strtol(back ? rest.slice(1) : rest), relative, back }
}

/** `source` with its first `count` bytes read off, or null when it ends
 * first. Mirrors Python's _past. */
async function past(
  source: AsyncIterable<Uint8Array>,
  count: number,
): Promise<AsyncIterable<Uint8Array> | null> {
  const iterator = chunks(source)
  let held: Uint8Array = new Uint8Array()
  let left = count
  while (left > 0) {
    const next = await iterator.next()
    if (next.done === true) return null
    held = next.value.subarray(Math.min(left, next.value.byteLength))
    left -= next.value.byteLength - held.byteLength
  }
  return asyncChain([held, iterator])
}

/** `source` cut at `limit` bytes, closed once they are out. Mirrors Python's
 * _limited. */
async function* limited(
  source: AsyncIterable<Uint8Array>,
  limit: number | null,
): AsyncIterable<Uint8Array> {
  let left = limit
  for await (const piece of chunks(source)) {
    let chunk = piece
    if (left !== null) {
      chunk = chunk.subarray(0, left)
      left -= chunk.byteLength
    }
    if (chunk.byteLength > 0) yield chunk
    if (left === 0) break
  }
}

/**
 * INFILE from where `-s` puts it and within `-l`, and the offset its first
 * byte has; null when xxd cannot seek there. A file seeks: past its end it
 * dumps nothing, before its start it cannot, and a seek from its end reads it
 * whole for its size. Stdin cannot seek, so it is read off, and ends too soon
 * or seeks from its end only to fail. Mirrors Python's _seeked.
 */
async function seeked(
  path: PathSpec | null,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  seek: XxdSeek,
  limit: number | null,
): Promise<[AsyncIterable<Uint8Array>, number] | null> {
  const piped = path === null || isStdin(path)
  const source = path === null ? resolveSource(stdin) : read(path)
  if (piped && seek.back) return null
  let start: number
  if (!seek.back) {
    start = seek.offset
  } else if (seek.relative) {
    start = -seek.offset
  } else {
    const kept: Uint8Array[] = []
    let size = 0
    let total = 0
    for await (const chunk of chunks(source)) {
      total += chunk.length
      kept.push(chunk)
      size += chunk.length
      while (kept[0] !== undefined && size - kept[0].length >= seek.offset) {
        size -= kept[0].length
        kept.shift()
      }
      if (kept[0] !== undefined && size > seek.offset) {
        kept[0] = kept[0].subarray(size - seek.offset)
        size = seek.offset
      }
    }
    start = total - seek.offset
    if (start < 0) return null
    return [limited(asyncChain(kept), limit), start]
  }
  if (start < 0) return null
  const after = await past(source, start)
  if (after === null && piped) return null
  return [limited(after ?? singleChunk(new Uint8Array()), limit), start]
}

/**
 * Write the dump (or with -r the bytes) to OUTFILE, reading INFILE first, as
 * xxd opens it first. Mirrors Python's _write_output.
 */
async function writeOutput(
  paths: PathSpec[],
  source: AsyncIterable<Uint8Array>,
  readBytes: ((p: PathSpec) => Promise<Uint8Array>) | null,
  writeBytes: ((p: PathSpec, data: ByteSource) => Promise<void>) | null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null,
  render: () => AsyncIterable<Uint8Array> | null,
  plain: boolean,
): Promise<[ByteSource | null, IOResult]> {
  const [input, target] = paths
  if (input === undefined || target === undefined) return [null, new IOResult()]
  const failed = (p: PathSpec, err: unknown, exitCode: number): [ByteSource | null, IOResult] => [
    null,
    new IOResult({ stderr: ENC.encode(fsErrorLine('xxd', p, err)), exitCode }),
  ]
  const dump = render()
  let segments: [number, Uint8Array][] = []
  let data: ByteSource = new Uint8Array(0)
  const reading = { failed: false }
  try {
    if (dump === null) segments = await reverseSegments(source, plain)
    else
      data = await primeStream(dump, () => {
        reading.failed = true
      })
  } catch (err) {
    if (!isFsError(err)) throw err
    return failed(input, err, readFailExitCode('xxd', err))
  }
  if (dump === null && pwriteBytes !== null) {
    try {
      const stretches: [number, Uint8Array][] =
        segments.length > 0 ? segments : [[0, new Uint8Array()]]
      for (const [start, chunk] of stretches) {
        await pwriteBytes(target, chunk, start)
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      return failed(target, err, OPEN_OUTPUT_EXIT)
    }
    return [null, new IOResult()]
  }
  if (dump === null) {
    let existing: Uint8Array = new Uint8Array(0)
    try {
      if (readBytes !== null) existing = await readBytes(target)
    } catch (err) {
      if (!isFsError(err)) throw err
      if (!isEnoent(err)) return failed(target, err, OPEN_OUTPUT_EXIT)
    }
    data = patched(existing, segments)
  }
  if (writeBytes === null) {
    await closeQuietly(data)
    return [
      null,
      new IOResult({
        stderr: ENC.encode('xxd: output is not writable on this backend\n'),
        exitCode: OPEN_OUTPUT_EXIT,
      }),
    ]
  }
  try {
    await writeBytes(target, data)
  } catch (err) {
    if (!isFsError(err)) throw err
    return failed(
      reading.failed ? input : target,
      err,
      reading.failed ? readFailExitCode('xxd', err) : OPEN_OUTPUT_EXIT,
    )
  } finally {
    await closeQuietly(data)
  }
  return [null, new IOResult()]
}

interface XxdFlags {
  readonly reverse: boolean
  readonly plain: boolean
  readonly uppercase: boolean
  readonly cols: number
  readonly group: number
  readonly seek: XxdSeek
  readonly limit: number | null
}

function count(value: FlagValue | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : 0
  return parsed > 0 ? parsed : fallback
}

function parseFlags(bag: Record<string, FlagValue>): XxdFlags {
  const fl = new FlagView(bag, specOf('xxd'))
  return {
    reverse: fl.asBool('r'),
    plain: fl.asBool('p'),
    uppercase: fl.asBool('u'),
    cols: count(fl.raw('c'), 16),
    group: count(fl.raw('g'), 2),
    seek: parseSeek(fl.asStr('s') ?? ''),
    limit: parseLimit(fl.asStr('args_l')),
  }
}

/**
 * xxd over INFILE (or stdin) to OUTFILE (or stdout). A dump replaces
 * OUTFILE; -r writes into it at the dump's offsets and keeps the bytes around
 * them, as xxd does, through pwrite where the backend has one, so the stored
 * bytes are what it writes into and no gap is held here. Deliberate
 * divergence: xxd opens OUTFILE before it
 * reads, so an INFILE that is OUTFILE reads empty and a directory INFILE
 * leaves an empty OUTFILE behind; this reads first and writes once. Mirrors
 * Python's xxd.
 */
export async function xxdGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readBytes: ((p: PathSpec) => Promise<Uint8Array>) | null = null,
  writeBytes: ((p: PathSpec, data: ByteSource) => Promise<void>) | null = null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null = null,
): Promise<[ByteSource | null, IOResult]> {
  stream = stdinStream(stream, opts.stdin, true)
  const parsed = parseFlags(opts.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.XXD, paths[2]?.rawPath ?? '')
  const { seek, limit, uppercase, plain } = parsed
  let source: AsyncIterable<Uint8Array>
  let base = 0
  if (parsed.reverse) {
    source = paths[0] !== undefined ? stream(paths[0]) : resolveSource(opts.stdin)
    if (seek.offset !== 0 || (limit ?? 0) > 0) {
      const after = await past(source, Math.max(seek.offset, 0))
      source = limited(after ?? singleChunk(new Uint8Array()), limit !== 0 ? limit : null)
    }
  } else {
    const found = await seeked(paths[0] ?? null, stream, opts.stdin, seek, limit)
    if (found === null) {
      return [null, new IOResult({ exitCode: CANNOT_SEEK_EXIT, stderr: ENC.encode(CANNOT_SEEK) })]
    }
    ;[source, base] = found
  }
  const render = (): AsyncIterable<Uint8Array> | null => {
    if (parsed.reverse) return null
    if (parsed.plain) return xxdPlainStream(source, uppercase)
    return xxdDumpStream(source, parsed.cols, parsed.group, uppercase, base)
  }
  const target = paths[1]
  if (target !== undefined && !isStdin(target)) {
    return writeOutput(paths, source, readBytes, writeBytes, pwriteBytes, render, plain)
  }
  const io = new IOResult()
  return [render() ?? xxdReverseStream(source, io, plain), io]
}
