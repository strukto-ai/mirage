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

function trimToLines(buf: Uint8Array, maxLines: number): Uint8Array {
  let count = 0
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] === NEWLINE) {
      count++
      if (count === maxLines) return buf.subarray(0, i + 1)
    }
  }
  return buf
}

function buildNotice(limit: Limit): Uint8Array {
  const parts: string[] = []
  if (limit.maxLines !== null) parts.push(`${String(limit.maxLines)} lines`)
  if (limit.maxBytes !== null) parts.push(`${String(limit.maxBytes)} bytes`)
  const detail = parts.join(' / ')
  return ENC.encode(
    `output truncated at limit (${detail}); ` +
      `narrow with grep, or read more with head -n / tail -n / ` +
      `a more specific path\n`,
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

function countNewlines(buf: Uint8Array): number {
  let n = 0
  for (let i = 0; i < buf.byteLength; i++) {
    if (buf[i] === NEWLINE) n++
  }
  return n
}

export async function applyLimit(
  src: ByteSource,
  limit: Limit | null,
): Promise<[ByteSource | null, IOResult]> {
  if (limit === null) return [src, new IOResult()]
  const { maxLines, maxBytes } = limit
  if (maxLines === null && maxBytes === null) return [src, new IOResult()]

  const chunks: Uint8Array[] = []
  let total = 0
  let newlineCount = 0
  let truncated = false

  const iterable: AsyncIterable<Uint8Array> = src instanceof Uint8Array ? yieldBytes(src) : src

  for await (const chunk of iterable) {
    chunks.push(chunk)
    total += chunk.byteLength
    if (maxLines !== null) newlineCount += countNewlines(chunk)
    if (maxBytes !== null && total > maxBytes) {
      truncated = true
      break
    }
    if (maxLines !== null && newlineCount >= maxLines) {
      truncated = true
      break
    }
  }

  let data = concat(chunks, total)
  if (maxBytes !== null && data.byteLength > maxBytes) {
    data = data.subarray(0, maxBytes)
  } else if (maxLines !== null && truncated) {
    data = trimToLines(data, maxLines)
  }

  if (!truncated) return [data, new IOResult()]
  const notice = buildNotice(limit)
  if (limit.onExceed === OnExceed.ERROR) {
    return [null, new IOResult({ exitCode: 1, stderr: notice })]
  }
  return [data, new IOResult({ stderr: notice })]
}

/**
 * Apply output caps at a boundary and merge the outcome.
 *
 * The one boundary rule, shared by the command tree and the
 * whole-line runtimes: cap stdout, append the truncation notice to
 * stderr, and let an ERROR-mode guard override the exit code.
 */
export async function guardOutput(
  stdout: ByteSource | null,
  stderr: ByteSource | null,
  exitCode: number,
  limit: Limit | null,
): Promise<[ByteSource | null, ByteSource | null, number]> {
  if (stdout === null) return [stdout, stderr, exitCode]
  const [data, sgIo] = await applyLimit(stdout, limit)
  if (sgIo.stderr !== null) {
    const existing = stderr !== null ? await materialize(stderr) : new Uint8Array()
    const added = await materialize(sgIo.stderr)
    const merged = new Uint8Array(existing.byteLength + added.byteLength)
    merged.set(existing, 0)
    merged.set(added, existing.byteLength)
    stderr = merged
  }
  return [data, stderr, sgIo.exitCode !== 0 ? sgIo.exitCode : exitCode]
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
