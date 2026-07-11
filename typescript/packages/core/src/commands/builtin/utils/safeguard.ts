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

import { yieldBytes } from '../../../io/stream.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { type CommandSafeguard, OnExceed } from '../../../types.ts'

const NEWLINE = 0x0a
const ENC = new TextEncoder()
const DEC = new TextDecoder()

export class CommandTimeoutError extends Error {
  readonly command: string
  readonly seconds: number
  constructor(command: string, seconds: number) {
    super(`${command}: timed out after ${String(seconds)}s`)
    this.name = 'CommandTimeoutError'
    this.command = command
    this.seconds = seconds
  }
}

export class SafeguardExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeguardExceededError'
  }
}

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
  safeguard: CommandSafeguard | null,
  command: string,
): ByteSource | null {
  if (stream === null || stream instanceof Uint8Array) return stream
  const timeout = safeguard?.timeoutSeconds ?? null
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

function buildNotice(safeguard: CommandSafeguard): Uint8Array {
  const parts: string[] = []
  if (safeguard.maxLines !== null) parts.push(`${String(safeguard.maxLines)} lines`)
  if (safeguard.maxBytes !== null) parts.push(`${String(safeguard.maxBytes)} bytes`)
  const limit = parts.join(' / ')
  return ENC.encode(
    `output truncated at safeguard limit (${limit}); ` +
      `narrow with grep, or read more with head -n / tail -n / ` +
      `a more specific path\n`,
  )
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

export async function applySafeguard(
  src: ByteSource,
  safeguard: CommandSafeguard | null,
): Promise<[ByteSource | null, IOResult]> {
  if (safeguard === null) return [src, new IOResult()]
  const { maxLines, maxBytes } = safeguard
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
  const notice = buildNotice(safeguard)
  if (safeguard.onExceed === OnExceed.ERROR) {
    return [null, new IOResult({ exitCode: 1, stderr: notice })]
  }
  return [data, new IOResult({ stderr: notice })]
}

export async function applyOpSafeguard(
  result: unknown,
  safeguard: CommandSafeguard | null,
): Promise<unknown> {
  if (safeguard === null) return result
  if (safeguard.maxBytes === null && safeguard.maxLines === null) return result
  const isBytes = result instanceof Uint8Array
  const isStream = result !== null && typeof result === 'object' && Symbol.asyncIterator in result
  if (!isBytes && !isStream) return result
  const [data, sgIo] = await applySafeguard(result as ByteSource, safeguard)
  if (sgIo.exitCode !== 0) {
    const message =
      sgIo.stderr instanceof Uint8Array ? DEC.decode(sgIo.stderr) : 'safeguard exceeded'
    throw new SafeguardExceededError(message.trim())
  }
  return data
}
