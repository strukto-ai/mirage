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
import { concat } from '../utils/bytes.ts'
import { chunks } from './cooperative.ts'

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>
export type StreamName = 'stdout' | 'stderr'

export interface OutputEvent {
  stream: StreamName
  data: Uint8Array
}

export type CommandOutput = [ByteSource | null, IOResult]
export type HandlerResult = CommandOutput | IOResult | null

/** Routing and settlement shared by a live handler's result and drain. */
export class OutputState {
  stderr: ((data: Uint8Array) => Promise<void>) | null = null
  settled = false
  readonly callbacks: (() => void)[] = []

  finish(): void {
    this.settled = true
    for (const callback of this.callbacks.splice(0)) callback()
  }
}

/**
 * Standard input redirected from a character device (`< /dev/null`). It reads
 * as the bytes it holds, like any other stdin, and tells a command that asks
 * whether a file, FIFO or socket is attached that none is: ripgrep asks before
 * it searches stdin rather than the working directory
 * (grep_cli::is_readable_stdin). Mirrors Python's DeviceInput.
 */
export class DeviceInput extends Uint8Array {}

export async function materialize(source: ByteSource | null | undefined): Promise<Uint8Array> {
  if (source === null || source === undefined) return new Uint8Array()
  if (source instanceof Uint8Array) return source
  const parts: Uint8Array[] = []
  for await (const chunk of chunks(source)) parts.push(chunk)
  return concat(parts)
}

/**
 * The dispatcher's account of what actually ran, filled in place.
 *
 * A caller that observes ops passes one per dispatch and reads it back
 * whatever happens next: the dispatcher stamps it the moment an op
 * completes, before invalidation, the post gate, or an output cap run,
 * so a failure in any of those cannot erase the fact that the backend
 * already did the work. Riding the result loses that fact on every
 * error, and riding the exception only covers exceptions the dispatcher
 * itself defines; a report object covers a foreign error (a
 * cache-store outage, an invalid policy return) the same way.
 *
 * `completed` says the op ran against its answering store; false until
 * the dispatcher says otherwise, so a refusal at a pre gate or a backend
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

/**
 * One `du` operand as measured, before its rows are rendered.
 *
 * du derives every row from the files it counted, so a line spanning mounts
 * renders each mount's own measurement as one tree, the way find's actions
 * run over every mount's `matchedRuns`. `leaves` are every file counted, as
 * (virtual path, bytes); `directories` the directories the walk met, which
 * keep a row though no counted file lies under them.
 */
export interface SizedRun {
  readonly leaves: readonly (readonly [string, number])[]
  readonly directories: readonly string[]
}

/**
 * One `wc` operand as counted, before its row is rendered.
 *
 * A line spanning mounts lays every mount's own counts out as one report,
 * with one column width and one total, the way du renders every mount's
 * `sizedRuns` as one tree. `values` are the counts the row shows, in GNU's
 * column order; `label` the name it prints, null for none.
 */
export interface CountedRun {
  readonly values: readonly number[]
  readonly label: string | null
}

export interface IOResultInit {
  stdout?: ByteSource | null
  stderr?: ByteSource | null
  exitCode?: number
  producer?: Producer | null
  matchedRuns?: PathSpec[][] | null
  sizedRuns?: SizedRun[] | null
  countedRuns?: CountedRun[] | null
  refusal?: Refusal | null
}

export class IOResult {
  // Structured selection before display rendering, for later actions:
  // one list of rows per start point, in operand order, so a nested or
  // repeated start point stays its own traversal (GNU walks each to
  // completion before the next).
  matchedRuns: PathSpec[][] | null
  // du's measurement before rendering, one run per operand it could read, in
  // operand order; null when the command supplied none.
  sizedRuns: SizedRun[] | null
  // wc's counts before rendering, one run per row it prints, in operand order
  // and without the total; null when the command supplied none.
  countedRuns: CountedRun[] | null
  stdout: ByteSource | null
  stderr: ByteSource | null
  private _exitCode: number
  // Provenance of this result (which command, spanning which
  // mounts); merge keeps the last command for attribution, not
  // ownership of every byte in a combined result. The workspace boundary hands it to the
  // policy layer as context. Facts ride the envelope as policy
  // input; the decision a chain hands down rides beside them as
  // `refusal`, written after the last hook has spoken.
  output: OutputState | null = null
  outputFinalized = false
  producer: Producer | null
  // Why the line did not run, when a policy or an unanswered ask
  // refused it; null on every ordinary run. stderr stays in bash's
  // voice, this carries the reason. merge keeps the rightmost record,
  // as it does the producer.
  refusal: Refusal | null
  streamSource: IOResult | null

  constructor(init: IOResultInit = {}) {
    this.matchedRuns = init.matchedRuns ?? null
    this.sizedRuns = init.sizedRuns ?? null
    this.countedRuns = init.countedRuns ?? null
    this.stdout = init.stdout ?? null
    this.stderr = init.stderr ?? null
    this._exitCode = init.exitCode ?? 0
    this.producer = init.producer ?? null
    this.refusal = init.refusal ?? null
    this.streamSource = null
  }

  // A delegating read: a streaming command's status can depend on its
  // content (grep settles the origin only when its stream drains), so a
  // merged result follows the link instead of holding a copy, and the
  // value is as fresh as the origin whenever it is read.
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
    // the link, so a lazy status settling after this merge (grep's, at
    // drain time) is still visible.
    const result = new IOResult({
      stdout: other.stdout,
      matchedRuns: other.matchedRuns,
      sizedRuns: other.sizedRuns,
      countedRuns: other.countedRuns,
      stderr: mergedStderr,
      producer: other.producer,
      refusal: other.refusal ?? this.refusal,
    })
    result.output = other.output
    result.outputFinalized = other.outputFinalized
    result.streamSource = other
    return result
  }
}

function decodeBytes(bytes: Uint8Array, errors: 'replace' | 'strict'): string {
  return new TextDecoder('utf-8', { fatal: errors === 'strict' }).decode(bytes)
}
