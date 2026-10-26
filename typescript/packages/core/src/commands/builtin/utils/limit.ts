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

import { concat } from '../../../utils/bytes.ts'
import { chunks } from '../../../io/cooperative.ts'
import { closeQuietly, ensureStream } from '../../../io/stream.ts'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { type Limit, OnExceed } from '../../../types.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import type { Context } from '../../config.ts'

const NEWLINE = 0x0a
const ENC = new TextEncoder()

const TIMED_OUT = Symbol('timed-out')

/** The start of the notice a command's capped output ends its stderr with. */
export const TRUNCATION_NOTICE = 'output truncated at limit'

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

/**
 * Wait for `promise` until its deadline, then throw a timeout error. The call
 * itself runs on, and a stream it answers after the deadline is closed, since
 * no one reads it and it may hold the backend open (an SSH follow's remote
 * `tail`). `start` is when the budget began (`performance.now()`), when work
 * before this call already spent part of it. Mirrors Python's
 * `run_with_timeout`, whose deadline cancels the call itself.
 */
export async function runWithTimeout<T>(
  promise: Promise<T>,
  seconds: number | null,
  name: string,
  start?: number,
): Promise<T> {
  if (seconds === null || seconds <= 0) return await promise
  const left = seconds * 1000 - (start === undefined ? 0 : performance.now() - start)
  // Spent before the call: a race against no time left loses to a call that
  // settles in a microtask.
  const result = left > 0 ? await withDeadline(promise, left) : TIMED_OUT
  if (result === TIMED_OUT) {
    void promise.then(
      async (late) => {
        if (late !== null && typeof late === 'object' && Symbol.asyncIterator in late) {
          await closeQuietly(late as AsyncIterable<unknown>)
        }
      },
      (err: unknown) => {
        console.debug(`${name}: a timed-out call failed after its deadline: ${String(err)}`)
      },
    )
    throw new CommandTimeoutError(name || '?', seconds)
  }
  return result
}

function buildNotice(limit: Limit): Uint8Array {
  const parts: string[] = []
  if (limit.maxLines !== null) parts.push(`${String(limit.maxLines)} lines`)
  if (limit.maxBytes !== null) parts.push(`${String(limit.maxBytes)} bytes`)
  const detail = parts.join(' / ')
  return ENC.encode(
    `${TRUNCATION_NOTICE} (${detail}); narrow the selection or raise command_limits for this command\n`,
  )
}

export async function* truncateStream(
  src: ByteSource,
  io: IOResult,
  limit: Limit,
): AsyncIterable<Uint8Array> {
  const maxBytes = limit.maxBytes
  const iterable = ensureStream(src)
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

async function* boundedStream(
  src: ByteSource,
  io: IOResult,
  limit: Limit,
  command = '',
): AsyncIterable<Uint8Array> {
  let total = 0
  let lines = 0
  const iterable = ensureStream(src)
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
      io.stderr = concat([await materialize(io.stderr), prefix, buildNotice(limit)])
      if (limit.onExceed === OnExceed.ERROR) io.exitCode = 1
      return
    }
  }
}

async function* errorStream(
  src: ByteSource,
  io: IOResult,
  limit: Limit,
  command: string,
): AsyncIterable<Uint8Array> {
  const outcome = new IOResult()
  const data = await materialize(boundedStream(src, outcome, limit, command))
  if (outcome.stderr !== null) {
    io.stderr = concat([await materialize(io.stderr), await materialize(outcome.stderr)])
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
  const io = new IOResult({ stderr, exitCode })
  const guarded = guardIO(stdout, io, limit)
  const data = guarded === null ? null : await materialize(guarded)
  return [data, io.stderr, io.exitCode]
}

/** An invocation's input under its abort; `split` as in chunks. */
export function guardInput(
  source: ByteSource,
  ctx: Pick<Context, 'signal'>,
  split = true,
): AsyncIterable<Uint8Array> {
  return chunks(source, ctx.signal, split)
}
