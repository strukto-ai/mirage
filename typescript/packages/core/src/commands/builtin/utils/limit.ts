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

import { chunks } from '../../../io/cooperative.ts'
import { yieldBytes } from '../../../io/stream.ts'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { type Limit, OnExceed } from '../../../types.ts'
import { CommandTimeoutError, LimitExceededError } from '../../errors.ts'

const NEWLINE = 0x0a
const ENC = new TextEncoder()
const DEC = new TextDecoder()

const TIMED_OUT = Symbol('timed-out')

/**
 * What a row-pushing command says when a mount's ceiling cut it short.
 *
 * `head -n` / `tail -n` on a database mount push the count into the query,
 * and the mount caps how many rows one read may return. A count past the
 * ceiling used to be clamped to it in silence, printing fewer lines than GNU
 * would with exit 0; the rows up to the ceiling are still printed, but this
 * notice goes to stderr and the command exits 1, as `du` does when its walk
 * stops early. Mirrors `row_cap_notice` in `utils/limit.py`.
 */
export function rowCapNotice(
  command: string,
  operand: string,
  count: number,
  unit: string,
  knob: string,
): Uint8Array {
  return ENC.encode(
    `${command}: ${operand}: stopped at ${String(count)} ${unit} (${knob}); the output is incomplete\n`,
  )
}

/**
 * Stream `src`, then append whatever `notices` gathered to `io`. The rows a
 * pushed-down read returns are only counted once the read has run, which is
 * while the command's output streams, so the notice and the failing status
 * land on `io` after the stream drains, the way `truncateStream` settles an
 * output cap. Mirrors `note_after` in `utils/limit.py`.
 */
export async function* noteAfter(
  src: ByteSource,
  io: IOResult,
  notices: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  yield* src instanceof Uint8Array ? yieldBytes(src) : src
  if (notices.length === 0) return
  const existing = io.stderr !== null ? await materialize(io.stderr) : new Uint8Array()
  const total = notices.reduce((n, notice) => n + notice.byteLength, existing.byteLength)
  const merged = new Uint8Array(total)
  merged.set(existing, 0)
  let at = existing.byteLength
  for (const notice of notices) {
    merged.set(notice, at)
    at += notice.byteLength
  }
  io.stderr = merged
  io.exitCode = 1
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(TIMED_OUT)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

async function* withTimeout(
  src: ByteSource,
  seconds: number,
  command: string,
): AsyncIterableIterator<Uint8Array> {
  const iterable: AsyncIterable<Uint8Array> = src instanceof Uint8Array ? yieldBytes(src) : src
  const iterator = iterable[Symbol.asyncIterator]()
  const deadline = performance.now() + seconds * 1000
  for (;;) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new CommandTimeoutError(command, seconds)
    const next = await withDeadline(iterator.next(), remaining)
    if (next === TIMED_OUT) throw new CommandTimeoutError(command, seconds)
    if (next.done === true) return
    yield next.value
  }
}

export function maybeWithTimeout(
  stream: ByteSource | null,
  limit: Limit | null,
  command: string,
): ByteSource | null {
  if (stream === null || stream instanceof Uint8Array) return stream
  const timeout = limit?.timeoutSeconds ?? null
  if (timeout === null || timeout <= 0) return stream
  return withTimeout(stream, timeout, command)
}

export async function runWithTimeout<T>(
  promise: Promise<T>,
  seconds: number | null,
  name: string,
): Promise<T> {
  if (seconds === null || seconds <= 0) return await promise
  const result = await withDeadline(promise, seconds * 1000)
  if (result === TIMED_OUT) throw new CommandTimeoutError(name || '?', seconds)
  return result
}

function buildNotice(limit: Limit): Uint8Array {
  const parts: string[] = []
  if (limit.maxLines !== null) parts.push(`${String(limit.maxLines)} lines`)
  if (limit.maxBytes !== null) parts.push(`${String(limit.maxBytes)} bytes`)
  const detail = parts.join(' / ')
  return ENC.encode(
    `output truncated at limit (${detail}); narrow the selection or raise command_limits for this command\n`,
  )
}

export async function* truncateStream(
  src: ByteSource,
  io: IOResult,
  limit: Limit,
): AsyncIterable<Uint8Array> {
  const maxBytes = limit.maxBytes
  const iterable: AsyncIterable<Uint8Array> = src instanceof Uint8Array ? yieldBytes(src) : src
  if (maxBytes === null) {
    yield* iterable
    return
  }
  let emitted = 0
  for await (const chunk of iterable) {
    const remaining = maxBytes - emitted
    if (chunk.byteLength <= remaining) {
      yield chunk
      emitted += chunk.byteLength
      continue
    }
    if (remaining > 0) yield chunk.subarray(0, remaining)
    const existing = io.stderr !== null ? await materialize(io.stderr) : new Uint8Array()
    const notice = buildNotice(limit)
    const merged = new Uint8Array(existing.byteLength + notice.byteLength)
    merged.set(existing, 0)
    merged.set(notice, existing.byteLength)
    io.stderr = merged
    if (limit.onExceed === OnExceed.ERROR) io.exitCode = 1
    return
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function* boundedStream(
  src: ByteSource,
  io: IOResult,
  limit: Limit,
  command = '',
): AsyncIterable<Uint8Array> {
  let total = 0
  let lines = 0
  const iterable = src instanceof Uint8Array ? yieldBytes(src) : src
  for await (const chunk of iterable) {
    let end =
      limit.maxBytes === null
        ? chunk.byteLength
        : Math.min(chunk.byteLength, Math.max(0, limit.maxBytes - total))
    if (limit.maxLines !== null) {
      if (lines >= limit.maxLines) end = 0
      else {
        for (let i = 0; i < end; i++) {
          if (chunk[i] === NEWLINE && ++lines === limit.maxLines) {
            end = i + 1
            break
          }
        }
      }
    }
    total += end
    if (end > 0) yield chunk.subarray(0, end)
    if (end < chunk.byteLength) {
      const prefix = command === '' ? new Uint8Array() : ENC.encode(`${command}: `)
      const parts = [await materialize(io.stderr), prefix, buildNotice(limit)]
      io.stderr = concat(
        parts,
        parts.reduce((n, part) => n + part.byteLength, 0),
      )
      if (limit.onExceed === OnExceed.ERROR) io.exitCode = 1
      return
    }
  }
}

export async function applyLimit(
  src: ByteSource,
  limit: Limit | null,
): Promise<[ByteSource | null, IOResult]> {
  const io = new IOResult()
  if (limit === null || (limit.maxLines === null && limit.maxBytes === null)) return [src, io]
  const data = await materialize(boundedStream(src, io, limit))
  return [io.exitCode !== 0 ? null : data, io]
}

/**
 * Apply output caps at a boundary and merge the outcome.
 *
 * The one boundary rule, shared by the command tree and the
 * whole-line runtimes: cap stdout, append the truncation notice to
 * stderr, and let an ERROR-mode guard override the exit code.
 */
async function* errorStream(
  src: ByteSource,
  io: IOResult,
  limit: Limit,
  command: string,
): AsyncIterable<Uint8Array> {
  const outcome = new IOResult()
  const data = await materialize(boundedStream(src, outcome, limit, command))
  if (outcome.stderr !== null) {
    const parts = [await materialize(io.stderr), await materialize(outcome.stderr)]
    io.stderr = concat(
      parts,
      parts.reduce((n, part) => n + part.byteLength, 0),
    )
  }
  if (outcome.exitCode !== 0) io.exitCode = outcome.exitCode
  else if (data.byteLength > 0) yield data
}

/** Attach a terminal cap; its consuming statement settles status and notices. */
export function guardIO(
  stdout: ByteSource | null,
  io: IOResult,
  limit: Limit | null,
  command = '',
): ByteSource | null {
  if (stdout === null || limit === null || (limit.maxLines === null && limit.maxBytes === null))
    return stdout
  return limit.onExceed === OnExceed.ERROR
    ? errorStream(stdout, io, limit, command)
    : boundedStream(stdout, io, limit, command)
}

export async function guardOutput(
  stdout: ByteSource | null,
  stderr: ByteSource | null,
  exitCode: number,
  limit: Limit | null,
): Promise<[ByteSource | null, ByteSource | null, number]> {
  const io = new IOResult({ stderr, exitCode })
  const guarded = guardIO(stdout, io, limit)
  const data = guarded === null ? null : await materialize(guarded)
  return [data, io.stderr, io.exitCode]
}

export async function applyOpLimit(result: unknown, limit: Limit | null): Promise<unknown> {
  if (limit === null) return result
  if (limit.maxBytes === null && limit.maxLines === null) return result
  const isBytes = result instanceof Uint8Array
  const isStream = result !== null && typeof result === 'object' && Symbol.asyncIterator in result
  if (!isBytes && !isStream) return result
  const [data, sgIo] = await applyLimit(result as ByteSource, limit)
  if (sgIo.exitCode !== 0) {
    const message = sgIo.stderr instanceof Uint8Array ? DEC.decode(sgIo.stderr) : 'limit exceeded'
    throw new LimitExceededError(message.trim())
  }
  return data
}

/** Capture an invocation's deadline before a lazy producer starts running. */
export function guardInput(
  source: ByteSource,
  opts: { signal?: AbortSignal; timeoutSeconds?: number; command?: string },
): AsyncIterable<Uint8Array> {
  const seconds = opts.timeoutSeconds
  const deadline = seconds !== undefined && seconds > 0 ? performance.now() + seconds * 1000 : null
  return (async function* () {
    for await (const chunk of chunks(source, opts.signal)) {
      if (deadline !== null && performance.now() >= deadline) {
        throw new CommandTimeoutError(opts.command ?? '?', seconds ?? 0)
      }
      yield chunk
    }
  })()
}
