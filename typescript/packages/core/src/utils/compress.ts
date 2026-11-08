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
import { yieldBytes } from '../io/stream.ts'
import { StreamRefusal } from '../rs/errors.ts'
import { closeStream, openStream, streamOutputChunks, type OpenStream } from '../rs/stream.ts'
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

const gzipFailure = z
  .object({
    reasons: z.array(z.string()),
    fatal: z.boolean(),
    exit_code: z.number().int(),
    keeps_output: z.boolean(),
    first_header: z.boolean(),
  })
  .strict()

const gzipFacts = z
  .object({
    name: z.string().nullable(),
    mtime: z.number().int(),
    header: z.number().int(),
    compressed: z.number().int(),
    crc: z.number().int(),
    size: z.number().int(),
  })
  .strict()

/** What `gzip -l` and `-v` read off an input besides its data: the first
 * member's stored name (null for none) and time (0 for none), the bytes
 * its header and trailer take (none once a second member follows, as the
 * reference counts them), the bytes read, and the CRC and length the
 * input's last eight bytes claim. Mirrors Python's `GzipFacts`. */
export type GzipFacts = z.infer<typeof gzipFacts>

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
  onFacts?: (facts: GzipFacts) => void,
): AsyncGenerator<Uint8Array, void> {
  const stream = await openStream('compress', config)
  try {
    for await (const data of streamOutputChunks(stream, source, undefined, false)) {
      yield* output(stream, data)
    }
    const error = failure(stream)
    if (error !== null) throw error
    if (onFacts !== undefined) {
      onFacts(gzipFacts.parse(JSON.parse(new TextDecoder().decode(stream.metadata()))))
    }
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    if (error.output.byteLength > 0) yield error.output
    throw new Error(error.message)
  } finally {
    await closeStream(stream)
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

/** Encode bounded chunks and close an abandoned source; `mtime` is the
 * time the header stores, 0 for none. */
export function gzipCompressStream(
  source: AsyncIterable<Uint8Array>,
  level: number | null = null,
  name = '',
  mtime = 0,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, {
    operation: 'encode',
    format: 'gzip',
    level: level ?? -1,
    name,
    mtime,
  })
}

/** Decode members and retain bytes produced before a checked failure;
 * `onFacts` hears the input's facts once it decodes whole. */
export function gunzipStream(
  source: AsyncIterable<Uint8Array>,
  test = false,
  passthrough = false,
  onFacts?: (facts: GzipFacts) => void,
): AsyncGenerator<Uint8Array, void> {
  return codecStream(source, { operation: 'decode', format: 'gzip', test, passthrough }, onFacts)
}

/** An input's facts read the way `gzip -l` reads them: checked whole, as
 * `-t` checks it, with nothing written. Throws `GzipDataError` when the
 * input does not decode. */
export async function readGzipFacts(source: AsyncIterable<Uint8Array>): Promise<GzipFacts> {
  const found: GzipFacts[] = []
  for await (const _ of codecStream(
    source,
    { operation: 'decode', format: 'gzip', list: true },
    (facts) => found.push(facts),
  )) {
    void _
  }
  const facts = found[0]
  if (facts === undefined) throw new Error('gzip listing ended without facts')
  return facts
}
