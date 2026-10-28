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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { concat } from '../../../utils/bytes.ts'
import { chunks } from '../../../io/cooperative.ts'
import type { ByteSource } from '../../../io/types.ts'
import { cInt, strtol } from '../utils/strtol.ts'
import { singleChunk } from '../utils/operands.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isEnoent, isFsError } from '../../../errors/fs.ts'
import type { Context } from '../../config.ts'
import { isStdin, resolveSource, stdinStream, streamOutput } from '../utils/stream.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { openStream, runStream, streamOutputChunks } from '../../../rs/stream.ts'
import { asyncChain } from '../../../io/stream.ts'
import { extraOperandError, readFailExitCode } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()

// xxd's exit for an OUTFILE it cannot open, for an INFILE it cannot seek
// where -s says, and for a dump that seeks backwards on a stream (vim's xxd
// 2024-12-07).
const OPEN_OUTPUT_EXIT = 3
const CANNOT_SEEK_EXIT = 4
const SEEK_BACK_EXIT = 5
const CANNOT_SEEK = 'xxd: Sorry, cannot seek.\n'
// The most octets vim's xxd puts on a line outside -p (its COLS), and its
// refusal of a -c past that or under 1.
const COLS_MAX = 256
const COLS_REFUSAL = `xxd: invalid number of columns (max. ${String(COLS_MAX)}).`

function dumpStream(
  source: AsyncIterable<Uint8Array>,
  cols: number,
  group: number,
  uppercase: boolean,
  base: number,
): Promise<AsyncIterable<Uint8Array>> {
  return openStream('xxd', { mode: 'dump', cols, group, uppercase, base }).then((stream) =>
    streamOutput(stream, source),
  )
}

function plainStream(
  source: AsyncIterable<Uint8Array>,
  uppercase: boolean,
  cols: number,
): Promise<AsyncIterable<Uint8Array>> {
  return openStream('xxd', { mode: 'plain', uppercase, cols }).then((stream) =>
    streamOutput(stream, source),
  )
}

/**
 * Revert a hexdump onto a stream, which can only move forward. Deliberate
 * divergence: stdout is a stream here even when the line redirects it to a
 * file, which xxd would seek, so an offset before the bytes written stops the
 * dump with xxd's refusal. Mirrors Python's _xxd_reverse_stream.
 */
async function* xxdReverseStream(
  source: AsyncIterable<Uint8Array>,
  io: IOResult,
  plain: boolean,
): AsyncIterable<Uint8Array> {
  const stream = await openStream('xxd', { mode: 'reverse', plain, segments: false })
  try {
    yield* streamOutputChunks(stream, source)
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    if (error.output.byteLength > 0) yield error.output
    io.exitCode = SEEK_BACK_EXIT
    io.stderr = ENC.encode(`${error.message}\n`)
  }
}

/**
 * Revert a hexdump into the stretches xxd writes into OUTFILE, each framed run
 * decoded as its bytes arrive. Each run lands at its offset, or where the last
 * one ended; runs that meet join one stretch, so a whole dump is one write at
 * 0. Mirrors Python's _reverse_segments.
 */
async function reverseSegments(
  source: AsyncIterable<Uint8Array>,
  plain: boolean,
): Promise<[number, Uint8Array][]> {
  const segments: { start: number; end: number; parts: Uint8Array[] }[] = []
  const header = new Uint8Array(16)
  const view = new DataView(header.buffer)
  let held = 0
  let left = 0
  let current: { start: number; end: number; parts: Uint8Array[] } = {
    start: -1,
    end: -1,
    parts: [],
  }
  for await (const part of runStream('xxd', { mode: 'reverse', plain, segments: true }, source)) {
    let at = 0
    while (at < part.byteLength) {
      if (left === 0) {
        const taken = Math.min(header.byteLength - held, part.byteLength - at)
        header.set(part.subarray(at, at + taken), held)
        held += taken
        at += taken
        if (held < header.byteLength) break
        held = 0
        const start = Number(view.getBigUint64(0, true))
        left = Number(view.getBigUint64(8, true))
        if (current.end !== start) {
          current = { start, end: start, parts: [] }
          segments.push(current)
        }
        continue
      }
      const taken = Math.min(left, part.byteLength - at)
      current.parts.push(part.slice(at, at + taken))
      current.end += taken
      at += taken
      left -= taken
    }
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
  const limit = Number(strtol(raw)[0])
  return limit < 0 ? null : limit
}

/** The `-s` operand. Mirrors Python's parse_seek. */
export function parseSeek(raw: string): XxdSeek {
  const relative = raw.startsWith('+')
  const rest = relative ? raw.slice(1) : raw
  const back = rest.startsWith('-')
  return { offset: Number(strtol(back ? rest.slice(1) : rest)[0]), relative, back }
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
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  writeBytes: ((p: PathSpec, data: ByteSource) => Promise<void>) | null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null,
  render: () => Promise<AsyncIterable<Uint8Array> | null>,
  plain: boolean,
): Promise<[ByteSource | null, IOResult]> {
  const [input, target] = paths
  if (input === undefined || target === undefined) return [null, new IOResult()]
  const failed = (p: PathSpec, err: unknown, exitCode: number): [ByteSource | null, IOResult] => [
    null,
    new IOResult({ stderr: ENC.encode(fsErrorLine('xxd', p, err)), exitCode }),
  ]
  const dump = await render()
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
  if (dump !== null && !isStdin(input) && input.virtual === target.virtual) {
    // xxd opens OUTFILE before it reads INFILE: the same file reads empty.
    await closeQuietly(data)
    data = new Uint8Array(0)
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
      existing = await materialize(stream(target))
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

// A `-c` or `-g` count as xxd reads it: `(int)strtol(text, NULL, 0)`, so a
// word with no number is 0 and only its leading number counts. Mirrors
// Python's `_octets`.
function octets(text: string): bigint {
  return cInt(strtol(text)[0])
}

// xxd's one refusal of a -c count, whatever was typed. Mirrors Python's
// `_cols_refusal`.
function colsRefusal(): string {
  return COLS_REFUSAL
}

// `-g` as xxd settles it against the line's `cols`: a negative count is the
// default 2, and one under 1 or past `cols` is the whole line, which is how
// `-g 0` turns grouping off. Mirrors Python's `_group_of`.
function groupOf(text: string | undefined, cols: number): number {
  const typed = text === undefined ? 2 : Number(octets(text))
  const group = typed < 0 ? 2 : typed
  return group < 1 || group > cols ? cols : group
}

function parseFlags(bag: Record<string, FlagValue>): XxdFlags {
  const fl = new FlagView(bag, specOf('xxd'))
  const plain = fl.asBool('p')
  const typedCols = fl.asNumber('c', octets, colsRefusal, {
    low: 0n,
    ...(plain ? {} : { high: BigInt(COLS_MAX) }),
  })
  // Only a dump outside -p caps the count. -c 0 is a dump's default 16, and
  // puts all of a -p dump on one line, whose default is 30.
  const typed = typedCols === undefined ? undefined : Number(typedCols)
  const cols = plain ? (typed ?? 30) : typed || 16
  return {
    reverse: fl.asBool('r'),
    plain,
    uppercase: fl.asBool('u'),
    cols,
    group: groupOf(fl.asText('g'), cols),
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
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  writeBytes: ((p: PathSpec, data: ByteSource) => Promise<void>) | null = null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null = null,
): Promise<[ByteSource | null, IOResult]> {
  const read = stdinStream(stream, ctx.stdin, true)
  const parsed = parseFlags(ctx.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.XXD, paths[2]?.rawPath ?? '')
  const { seek, limit, uppercase, plain } = parsed
  let source: AsyncIterable<Uint8Array>
  let base = 0
  if (parsed.reverse) {
    source = paths[0] !== undefined ? read(paths[0]) : resolveSource(ctx.stdin)
    if (seek.offset !== 0 || (limit ?? 0) > 0) {
      const after = await past(source, Math.max(seek.offset, 0))
      source = limited(after ?? singleChunk(new Uint8Array()), limit !== 0 ? limit : null)
    }
  } else {
    const found = await seeked(paths[0] ?? null, read, ctx.stdin, seek, limit)
    if (found === null) {
      return [null, new IOResult({ exitCode: CANNOT_SEEK_EXIT, stderr: ENC.encode(CANNOT_SEEK) })]
    }
    ;[source, base] = found
  }
  const render = async (): Promise<AsyncIterable<Uint8Array> | null> => {
    if (parsed.reverse) return null
    if (parsed.plain) return plainStream(source, uppercase, parsed.cols)
    return dumpStream(source, parsed.cols, parsed.group, uppercase, base)
  }
  const target = paths[1]
  if (target !== undefined && !isStdin(target)) {
    return writeOutput(paths, source, stream, writeBytes, pwriteBytes, render, plain)
  }
  const io = new IOResult()
  return [(await render()) ?? xxdReverseStream(source, io, plain), io]
}
