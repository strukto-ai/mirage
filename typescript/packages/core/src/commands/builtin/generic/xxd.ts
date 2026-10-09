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
import { type FlagValue } from '../../spec/types.ts'
import { concat } from '../../../io/cachable_iterator.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isEnoent, isFsError } from '../../../errors/fs.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { isStdin, resolveSource, stdinStream } from '../utils/stream.ts'
import { extraOperandError, readFailExitCode } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

// xxd's exit for an OUTFILE it cannot open, and for a dump that seeks
// backwards on a stream (vim's xxd 2024-12-07).
const OPEN_OUTPUT_EXIT = 3
const SEEK_BACK_EXIT = 5
// The most NUL bytes one chunk carries when a dump's offset skips ahead.
const GAP_CHUNK = 65536

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
): AsyncIterable<Uint8Array> {
  let offset = 0
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
 * Decode a hexdump into runs of bytes and the offsets they go to. A plain
 * (-p) dump has no offsets, so its one run continues from the start; a
 * character that is not a hex digit ends its line, and the digits pair
 * across lines. Mirrors Python's _reverse_runs.
 */
async function* reverseRuns(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<[number | null, Uint8Array]> {
  const text = DEC.decode(await materialize(source))
  const lines = text.split('\n')
  if (text.includes(':')) {
    for (const line of lines) {
      if (line !== '') yield reverseLine(line)
    }
    return
  }
  const digits = lines.map((line) => /^[0-9A-Fa-f\s]*/.exec(line)?.[0] ?? '').join('')
  yield [null, unhex(digits.replace(/\s+/g, ''))]
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
): AsyncIterable<Uint8Array> {
  let position = 0
  for await (const [offset, data] of reverseRuns(source)) {
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
async function reverseSegments(source: AsyncIterable<Uint8Array>): Promise<[number, Uint8Array][]> {
  const segments: { start: number; end: number; parts: Uint8Array[] }[] = []
  let position = 0
  for await (const [offset, data] of reverseRuns(source)) {
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

async function* applyLimits(
  source: AsyncIterable<Uint8Array>,
  skip: number,
  limit: number,
): AsyncIterable<Uint8Array> {
  let pos = 0
  let remaining = limit
  for await (let chunk of source) {
    const len = chunk.byteLength
    if (pos + len <= skip) {
      pos += len
      continue
    }
    if (pos < skip) {
      chunk = chunk.subarray(skip - pos)
      pos = skip
    }
    if (remaining <= 0) break
    if (chunk.byteLength > remaining) chunk = chunk.subarray(0, remaining)
    yield chunk
    remaining -= chunk.byteLength
    pos += chunk.byteLength
  }
}

void padLeft

/**
 * Write the dump (or with -r the bytes) to OUTFILE, reading INFILE first, as
 * xxd opens it first. Mirrors Python's _write_output.
 */
async function writeOutput(
  paths: PathSpec[],
  source: AsyncIterable<Uint8Array>,
  readBytes: ((p: PathSpec) => Promise<Uint8Array>) | null,
  writeBytes: ((p: PathSpec, data: Uint8Array) => Promise<void>) | null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null,
  render: () => AsyncIterable<Uint8Array> | null,
): Promise<CommandFnResult> {
  const [input, target] = paths
  if (input === undefined || target === undefined) return [null, new IOResult()]
  const failed = (p: PathSpec, err: unknown, exitCode: number): CommandFnResult => [
    null,
    new IOResult({ stderr: ENC.encode(fsErrorLine('xxd', p, err)), exitCode }),
  ]
  const dump = render()
  let segments: [number, Uint8Array][] = []
  let data: Uint8Array = new Uint8Array(0)
  try {
    if (dump === null) segments = await reverseSegments(source)
    else data = await materialize(dump)
  } catch (err) {
    if (!isFsError(err)) throw err
    return failed(input, err, readFailExitCode('xxd', err))
  }
  if (dump === null && pwriteBytes !== null) {
    try {
      const stretches: [number, Uint8Array][] = segments.length > 0 ? segments : [[0, data]]
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
    return failed(target, err, OPEN_OUTPUT_EXIT)
  }
  return [null, new IOResult()]
}

interface XxdFlags {
  readonly reverse: boolean
  readonly plain: boolean
  readonly uppercase: boolean
  readonly cols: number
  readonly group: number
  readonly skip: number
  readonly limit: number
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
    skip: count(fl.raw('s'), 0),
    limit: count(fl.raw('args_l'), 0),
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
  writeBytes: ((p: PathSpec, data: Uint8Array) => Promise<void>) | null = null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null = null,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  const parsed = parseFlags(opts.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.XXD, paths[2]?.rawPath ?? '')
  let source: AsyncIterable<Uint8Array>
  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    source = stream(first)
  } else {
    source = resolveSource(opts.stdin)
  }
  const { skip, limit, uppercase } = parsed
  if (skip > 0 || limit > 0) {
    source = applyLimits(source, skip, limit > 0 ? limit : Number.MAX_SAFE_INTEGER)
  }
  const render = (): AsyncIterable<Uint8Array> | null => {
    if (parsed.reverse) return null
    if (parsed.plain) return xxdPlainStream(source, uppercase)
    return xxdDumpStream(source, parsed.cols, parsed.group, uppercase)
  }
  const target = paths[1]
  if (target !== undefined && !isStdin(target)) {
    return writeOutput(paths, source, readBytes, writeBytes, pwriteBytes, render)
  }
  const io = new IOResult()
  return [render() ?? xxdReverseStream(source, io), io]
}
