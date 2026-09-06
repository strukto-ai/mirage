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

import type { PathSpec, Producer, Refusal } from '../types.ts'
import { CachableAsyncIterator } from './cachable_iterator.ts'

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>

export async function materialize(source: ByteSource | null | undefined): Promise<Uint8Array> {
  if (source === null || source === undefined) return new Uint8Array()
  if (source instanceof Uint8Array) return source
  if (source instanceof CachableAsyncIterator) return source.drain()
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return concat(chunks)
}

/**
 * The op door's account of what actually ran, filled in place.
 *
 * A caller that observes ops passes one per dispatch and reads it back
 * whatever happens next: the door stamps it the moment an op
 * completes, before invalidation, the post gate, or an output cap run,
 * so a failure in any of those cannot erase the fact that the backend
 * already did the work. Riding the result loses that fact on every
 * error, and riding the exception only covers exceptions the door
 * itself defines; a report object covers a foreign error (a
 * cache-store outage, an invalid policy return) the same way.
 *
 * `completed` says the op ran against its answering store; false until
 * the door says otherwise, so a refusal at a pre gate or a backend
 * failure leaves nothing to record. `source` names who answered when
 * that was not the owning mount ('ram' for a warm file-cache hit and
 * for a synthetic namespace answer; null means the owning mount).
 * `bytes` is what the answering store moved when the delivered result
 * no longer measures it; null means "the result is the measure".
 *
 * Mirrors Python's mirage.io.types.OpReport.
 */
export class OpReport {
  completed = false
  source: string | null = null
  bytes: number | null = null

  /** Stamp the report at the moment an op completes. */
  served(source: string | null = null, moved: number | null = null): void {
    this.completed = true
    this.source = source
    this.bytes = moved
  }
}

export interface IOResultInit {
  stdout?: ByteSource | null
  stderr?: ByteSource | null
  exitCode?: number
  reads?: Record<string, ByteSource>
  writes?: Record<string, ByteSource>
  cache?: string[]
  producer?: Producer | null
  mutated?: boolean | null
  matchedRuns?: PathSpec[][] | null
  refusal?: Refusal | null
}

export class IOResult {
  // Structured selection before display rendering, for later actions:
  // one list of rows per start point, in operand order, so a nested or
  // repeated start point stays its own traversal (GNU walks each to
  // completion before the next).
  matchedRuns: PathSpec[][] | null
  stdout: ByteSource | null
  stderr: ByteSource | null
  private _exitCode: number
  reads: Record<string, ByteSource>
  writes: Record<string, ByteSource>
  cache: string[]
  // Provenance of this result (which command, spanning which
  // mounts); merge keeps the rightmost producer, mirroring whose
  // stream the shell shows. The workspace boundary hands it to the
  // policy layer as context. Facts ride the envelope as policy
  // input; the decision a chain hands down rides beside them as
  // `refusal`, written after the last hook has spoken.
  producer: Producer | null
  // Whether this run changed service state, when only the handler can
  // tell. A CLI leaf declares `write` statically because for almost every
  // verb it is static, but `gh api` carries its method on the line, so a
  // plain `gh api /user` is a read through a leaf that is declared
  // writable. null leaves the spec's answer standing.
  mutated: boolean | null
  // Why the line did not run, when a policy or an unanswered ask
  // refused it; null on every ordinary run. stderr stays in bash's
  // voice, this carries the reason. merge keeps the rightmost record,
  // as it does the producer.
  refusal: Refusal | null
  streamSource: IOResult | null

  constructor(init: IOResultInit = {}) {
    this.matchedRuns = init.matchedRuns ?? null
    this.stdout = init.stdout ?? null
    this.stderr = init.stderr ?? null
    this._exitCode = init.exitCode ?? 0
    this.reads = init.reads ?? {}
    this.writes = init.writes ?? {}
    this.cache = init.cache ?? []
    this.producer = init.producer ?? null
    this.mutated = init.mutated ?? null
    this.refusal = init.refusal ?? null
    this.streamSource = null
  }

  // A delegating read: a streaming command's status can depend on its
  // content (grep's exitOnEmpty settles the origin only when the stream
  // drains), so a merged result follows the link instead of holding a
  // copy, and the value is as fresh as the origin whenever it is read.
  get exitCode(): number {
    if (this.streamSource !== null) return this.streamSource.exitCode
    return this._exitCode
  }

  // An explicit write stores locally and severs the link, so an
  // aggregated or overridden status (fanOutTraversal, timeouts) always
  // wins over the lazy one.
  set exitCode(v: number) {
    this._exitCode = v
    this.streamSource = null
  }

  async materializeStdout(): Promise<Uint8Array> {
    const bytes = await materialize(this.stdout)
    this.stdout = bytes
    return bytes
  }

  async stdoutStr(errors: 'replace' | 'strict' = 'replace'): Promise<string> {
    return decodeBytes(await this.materializeStdout(), errors)
  }

  async materializeStderr(): Promise<Uint8Array> {
    const bytes = await materialize(this.stderr)
    this.stderr = bytes
    return bytes
  }

  async stderrStr(errors: 'replace' | 'strict' = 'replace'): Promise<string> {
    return decodeBytes(await this.materializeStderr(), errors)
  }

  async merge(other: IOResult): Promise<IOResult> {
    const leftStderr = await materialize(this.stderr)
    const rightStderr = await materialize(other.stderr)
    let mergedStderr: Uint8Array | null = null
    if (leftStderr.byteLength > 0 || rightStderr.byteLength > 0) {
      mergedStderr = concat([leftStderr, rightStderr])
    }
    // The exit code is not copied: the merged result reads it through
    // the link, so a lazy status settling after this merge (exitOnEmpty
    // firing at drain time) is still visible.
    const result = new IOResult({
      stdout: other.stdout,
      matchedRuns: other.matchedRuns,
      stderr: mergedStderr,
      reads: { ...this.reads, ...other.reads },
      writes: { ...this.writes, ...other.writes },
      cache: [...this.cache, ...other.cache],
      producer: other.producer,
      refusal: other.refusal ?? this.refusal,
    })
    result.streamSource = other
    return result
  }
}

function decodeBytes(bytes: Uint8Array, errors: 'replace' | 'strict'): string {
  return new TextDecoder('utf-8', { fatal: errors === 'strict' }).decode(bytes)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
