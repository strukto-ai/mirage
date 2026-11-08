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
import { CHUNK_SIZE, chunks } from '../../../io/cooperative.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import type { ByteSource } from '../../../io/types.ts'
import { singleChunk } from '../utils/operands.ts'
import { IOResult } from '../../../io/types.ts'
import { LineFacts, type PathSpec } from '../../../types.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { isEnoent, isFsError } from '../../../errors/fs.ts'
import type { Context } from '../../config.ts'
import { isStdin, resolveSource, stdinStream, streamOutput } from '../utils/stream.ts'
import type { util } from 'zod'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { openStream, runStream, streamOutputChunks } from '../../../rs/stream.ts'
import { asyncChain } from '../../../io/stream.ts'
import { extraOperandError, readFailExitCode } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { byteView } from '../../../shell/bytes.ts'

const ENC = new TextEncoder()

// xxd's exit for an OUTFILE it cannot open, for an INFILE it cannot seek
// where -s says, and for a dump that seeks backwards on a stream (vim's xxd
// 2024-12-07).
const OPEN_OUTPUT_EXIT = 3
const CANNOT_SEEK_EXIT = 4
const SEEK_BACK_EXIT = 5
const CANNOT_SEEK = 'xxd: Sorry, cannot seek.\n'

/** A dump of `source` as the scan's `render` describes it, its offsets from
 * `base` past `-o` and a `-i` array named `name`. Mirrors Python's
 * _forward_stream. */
async function forwardStream(
  source: AsyncIterable<Uint8Array>,
  render: Readonly<Record<string, util.JSONType>>,
  base: number,
  name: string | null,
): Promise<AsyncIterable<Uint8Array>> {
  const config = { ...render }
  if (config.mode === 'dump') config.base = base
  if (config.mode === 'include') config.name = name === null ? null : byteView(name)
  return streamOutput(await openStream('xxd', config), source)
}

function backwards(refusal: StreamRefusal): IOResult {
  return new IOResult({ exitCode: SEEK_BACK_EXIT, stderr: ENC.encode(`${refusal.message}\n`) })
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
  revert: Readonly<Record<string, util.JSONType>>,
): AsyncIterable<Uint8Array> {
  const stream = await openStream('xxd', { ...revert, segments: false })
  try {
    yield* streamOutputChunks(stream, source)
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    if (error.output.byteLength > 0) yield error.output
    const refused = backwards(error)
    io.exitCode = refused.exitCode
    io.stderr = refused.stderr
  }
}

/** Decode Rust's offset/length frames one bounded write at a time. */
async function* reverseSegments(source: ByteSource): AsyncGenerator<[number, Uint8Array]> {
  const header = new Uint8Array(16)
  const view = new DataView(header.buffer)
  let held = 0
  let left = 0
  let start = 0
  const pending = new Uint8Array(CHUNK_SIZE)
  let pendingSize = 0
  let pendingStart = 0
  for await (const part of chunks(source)) {
    let at = 0
    while (at < part.byteLength) {
      if (left === 0) {
        const taken = Math.min(header.byteLength - held, part.byteLength - at)
        header.set(part.subarray(at, at + taken), held)
        held += taken
        at += taken
        if (held < header.byteLength) break
        held = 0
        start = Number(view.getBigUint64(0, true))
        left = Number(view.getBigUint64(8, true))
        continue
      }
      if (pendingSize > 0 && start !== pendingStart + pendingSize) {
        yield [pendingStart, pending.slice(0, pendingSize)]
        pendingSize = 0
      }
      if (pendingSize === 0) pendingStart = start
      const taken = Math.min(left, part.byteLength - at, CHUNK_SIZE - pendingSize)
      pending.set(part.subarray(at, at + taken), pendingSize)
      pendingSize += taken
      start += taken
      at += taken
      left -= taken
      if (pendingSize === CHUNK_SIZE) {
        yield [pendingStart, pending.slice()]
        pendingSize = 0
      }
    }
  }
  if (pendingSize > 0) yield [pendingStart, pending.slice(0, pendingSize)]
}

/** Patch a spillable copy so writes never truncate an input still read. */
async function patched(existing: ByteSource, segments: ByteSource): Promise<ByteSource> {
  let stored = new ByteSpool()
  const budget = new YieldBudget()
  try {
    try {
      await stored.fill(existing)
    } catch (err) {
      if (!isEnoent(err)) throw err
      await stored.close()
      stored = new ByteSpool()
    }
    for await (const [start, data] of reverseSegments(segments)) {
      const end = start + data.byteLength
      while (stored.size < end) {
        await budget.run()
        await stored.append(new Uint8Array(Math.min(CHUNK_SIZE, end - stored.size)))
      }
      await stored.write(start, data)
    }
    return await stored.output()
  } catch (err) {
    await stored.close()
    throw err
  }
}

/** `-s` as xxd reads it: `[+][-]offset`. `relative` (`+`) seeks from where
 * INFILE stands, which is its start here; `back` (`-`) seeks back from its
 * end. Mirrors Python's XxdSeek. */
export interface XxdSeek {
  readonly offset: number
  readonly relative: boolean
  readonly back: boolean
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
  revert: Readonly<Record<string, util.JSONType>>,
): Promise<[ByteSource | null, IOResult]> {
  const [input, target] = paths
  if (input === undefined || target === undefined) return [null, new IOResult()]
  const failed = (p: PathSpec, err: unknown, exitCode: number): [ByteSource | null, IOResult] => [
    null,
    new IOResult({ stderr: ENC.encode(fsErrorLine('xxd', p, err)), exitCode }),
  ]
  const dump = await render()
  let segments: ByteSource = new Uint8Array()
  let data: ByteSource = new Uint8Array(0)
  let done = new IOResult()
  const reading = { failed: false }
  try {
    if (dump === null) {
      const stored = new ByteSpool()
      try {
        try {
          await stored.fill(runStream('xxd', { ...revert, segments: true }, source))
        } catch (err) {
          if (!(err instanceof StreamRefusal)) throw err
          await stored.append(err.output)
          done = backwards(err)
        }
        segments = await stored.output()
      } catch (err) {
        await stored.close()
        throw err
      }
    } else
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
      let wrote = false
      for await (const [start, chunk] of reverseSegments(segments)) {
        await pwriteBytes(target, chunk, start)
        wrote = true
      }
      if (!wrote) await pwriteBytes(target, new Uint8Array(), 0)
    } catch (err) {
      if (!isFsError(err)) throw err
      return failed(target, err, OPEN_OUTPUT_EXIT)
    } finally {
      await closeQuietly(segments)
    }
    return [null, done]
  }
  if (dump === null) {
    try {
      data = await patched(stream(target), segments)
    } catch (err) {
      if (!isFsError(err)) throw err
      return failed(target, err, OPEN_OUTPUT_EXIT)
    } finally {
      await closeQuietly(segments)
    }
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
  return [null, done]
}

export interface XxdFlags {
  readonly reverse: boolean
  readonly plain: boolean
  readonly render: Readonly<Record<string, util.JSONType>>
  readonly seek: XxdSeek
  readonly limit: number | null
  readonly name: string | null
}

/**
 * xxd's counts read by mirage-rs before any operand is resolved: the flags, or
 * xxd's refusal of a -c. Mirrors Python's `parse_flags`.
 */
export function parseFlags(bag: Record<string, FlagValue>): XxdFlags | IOResult {
  const fl = new FlagView(bag, specOf('xxd'))
  let values
  try {
    values = scan(
      'xxd',
      fl.texts('p', 'c', 'g', 's', 'args_l', 'b', 'e', 'i', 'u', 'a', 'd', 'E', 'C', 'n', 'o'),
    )
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const { render, seek, limit } = values as unknown as Pick<XxdFlags, 'render' | 'seek' | 'limit'>
  return {
    reverse: fl.asBool('r'),
    plain: fl.asBool('p'),
    render,
    seek,
    limit,
    name: fl.asText('n') ?? null,
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
  parsed: XxdFlags,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  writeBytes: ((p: PathSpec, data: ByteSource) => Promise<void>) | null = null,
  pwriteBytes: ((p: PathSpec, data: Uint8Array, offset: number) => Promise<void>) | null = null,
): Promise<[ByteSource | null, IOResult]> {
  const read = stdinStream(stream, ctx.stdin, true)
  if (paths.length > 2) throw extraOperandError(CommandName.XXD, paths[2]?.rawPath ?? '')
  const { seek, limit, plain } = parsed
  const first = paths[0]
  const name = parsed.name ?? (first !== undefined && !isStdin(first) ? first.rawPath : null)
  const revert: Readonly<Record<string, util.JSONType>> = {
    mode: 'reverse',
    plain,
    cols: parsed.render.cols ?? null,
    base: seek.back ? -seek.offset : seek.offset,
  }
  let source: AsyncIterable<Uint8Array>
  let base = 0
  if (parsed.reverse) {
    source = paths[0] !== undefined ? read(paths[0]) : resolveSource(ctx.stdin)
  } else {
    const found = await seeked(paths[0] ?? null, read, ctx.stdin, seek, limit)
    if (found === null) {
      return [null, new IOResult({ exitCode: CANNOT_SEEK_EXIT, stderr: ENC.encode(CANNOT_SEEK) })]
    }
    ;[source, base] = found
  }
  const render = async (): Promise<AsyncIterable<Uint8Array> | null> => {
    if (parsed.reverse) return null
    return forwardStream(source, parsed.render, base, name)
  }
  const target = paths[1]
  if (target !== undefined && !isStdin(target)) {
    return writeOutput(paths, source, stream, writeBytes, pwriteBytes, render, revert)
  }
  const io = new IOResult()
  return [(await render()) ?? xxdReverseStream(source, io, revert), io]
}

function namesOutput(operands: readonly (string | PathSpec)[]): boolean {
  return operands.length > 1 || operands.some((w) => typeof w !== 'string' && w.pattern !== null)
}

/**
 * An xxd line writes its second operand, which a pattern the backend
 * expands may name too; a quoted name is no pattern. Mirrors Python's
 * `facts`.
 */
export function facts(fl: FlagView, operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({ writes: namesOutput(operands) })
}
