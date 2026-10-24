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

import { z } from 'zod'
import { chunks } from '../io/cooperative.ts'
import { yieldBytes } from '../io/stream.ts'
import { YieldBudget } from '../io/yield_budget.ts'
import { StreamRefusal } from '../rs/errors.ts'
import { openStream, type OpenStream } from '../rs/stream.ts'
import type { JsonValue } from '../types.ts'
import { materialize } from '../io/types.ts'

export class GzipDataError extends Error {
  readonly reasons: readonly string[]
  readonly fatal: boolean

  constructor(
    reasons: readonly string[],
    fatal: boolean,
    readonly exitCode = 1,
    readonly keepsOutput = false,
    readonly firstHeader = false,
  ) {
    super(reasons.join('\n'))
    this.name = 'GzipDataError'
    this.reasons = reasons
    this.fatal = fatal
  }

  /** gzip's lines for the failure, the input named `label`. */
  render(label: string): string {
    return this.reasons.map((reason) => `${reason.split('{}').join(label)}\n`).join('')
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** The CRC-32 of `data`, continuing from the CRC of the bytes before it. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.byteLength; i++) {
    c = (CRC_TABLE[((c ^ (data[i] ?? 0)) & 0xff) >>> 0] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const gzipFailure = z
  .object({
    reasons: z.array(z.string()),
    fatal: z.boolean(),
    exit_code: z.number().int(),
    keeps_output: z.boolean(),
    first_header: z.boolean(),
  })
  .strict()

function failure(stream: OpenStream): GzipDataError | null {
  if (stream.status() === 0) return null
  const record = gzipFailure.parse(JSON.parse(new TextDecoder().decode(stream.takeStderr())))
  return new GzipDataError(
    record.reasons,
    record.fatal,
    record.exit_code,
    record.keeps_output,
    record.first_header,
  )
}

function* output(stream: OpenStream, data: Uint8Array): Generator<Uint8Array> {
  const error = failure(stream)
  if (data.byteLength > 0) yield data
  if (error !== null) throw error
}

async function* codecStream(
  source: AsyncIterable<Uint8Array>,
  config: Readonly<Record<string, JsonValue>>,
): AsyncGenerator<Uint8Array, void> {
  const stream = await openStream('compress', config)
  const budget = new YieldBudget()
  try {
    for await (const data of chunks(source)) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      try {
        yield* output(stream, stream.feed(data))
        while (stream.busy()) {
          const draining = budget.run()
          if (draining !== undefined) await draining
          yield* output(stream, stream.drain())
        }
      } catch (error) {
        if (!(error instanceof StreamRefusal)) throw error
        if (error.output.byteLength > 0) yield error.output
        throw new Error(error.message)
      }
    }
    const finishing = budget.run()
    if (finishing !== undefined) await finishing
    try {
      yield* output(stream, stream.finish())
      while (stream.busy()) {
        const pending = budget.run()
        if (pending !== undefined) await pending
        yield* output(stream, stream.drain())
      }
    } catch (error) {
      if (!(error instanceof StreamRefusal)) throw error
      if (error.output.byteLength > 0) yield error.output
      throw new Error(error.message)
    }
  } finally {
    stream.close()
  }
}

/** Encode one member through the shared codec. */
export async function gzip(
  bytes: Uint8Array,
  name = '',
  level: number | null = null,
): Promise<Uint8Array> {
  return materialize(gzipCompressStream(yieldBytes(bytes), level, name))
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return materialize(gunzipStream(yieldBytes(bytes)))
}

/** Encode bounded chunks and close an abandoned source. */
export function gzipCompressStream(
  source: AsyncIterable<Uint8Array>,
  level: number | null = null,
  name = '',
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'encode', format: 'gzip', level: level ?? -1, name })
}

/** Decode members and retain bytes produced before a checked failure. */
export function gunzipStream(
  source: AsyncIterable<Uint8Array>,
  test = false,
  passthrough = false,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'decode', format: 'gzip', test, passthrough })
}

export function deflateRawStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'encode', format: 'raw' })
}

export function inflateRawStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'decode', format: 'raw' })
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return materialize(inflateRawStream(yieldBytes(bytes)))
}

export type Codec = 'bzip2' | 'xz'

/** Encode one bzip2 or xz stream at its program's default level. */
export function compressStream(
  source: AsyncIterable<Uint8Array>,
  codec: Codec,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'encode', format: codec })
}

/**
 * Decode concatenated bzip2 or xz streams, failing in that program's words
 * as `gunzipStream` fails in gzip's.
 */
export function decompressStream(
  source: AsyncIterable<Uint8Array>,
  codec: Codec,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'decode', format: codec })
}
