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

/** Settlement of a result whose fields fill in as its output drains. */
export class OutputState {
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

/**
 * A streamed read of a live pipe (a process substitution's `/dev/fd/N`),
 * which another task is still writing, so its reader takes the bytes as they
 * come. Mirrors Python's PipeStream.
 */
export class PipeStream implements AsyncIterable<Uint8Array> {
  private iterator: AsyncIterator<Uint8Array> | undefined

  /** `path` is the descriptor it was opened at, `end` the pipe itself. */
  constructor(
    private readonly stream: AsyncIterable<Uint8Array>,
    readonly path: PathSpec,
    readonly end: PipeEnd,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.iterator ??= this.stream[Symbol.asyncIterator]()
    return this.iterator
  }

  /** Close the read, for the scope that ends its pipe. Mirrors Python's PipeStream.aclose. */
  async close(): Promise<void> {
    await (this.iterator ?? this.stream[Symbol.asyncIterator]()).return?.()
  }
}

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
 * `path` is the path the op ran on once the dispatcher followed its
 * links, which is what a record names; null until the walk is done.
 *
 * Mirrors Python's mirage.io.types.OpReport.
 */
export class OpReport {
  completed = false
  source: string | null = null
  bytes: number | null = null
  path: string | null = null
  /**
   * The backing file a stat resolved to without running (`admit_only`): its
   * store and the key in it, alike for every workspace that mounts that store.
   * Null when no mount answers.
   */
  store: string | null = null

  /** Stamp the report at the moment an op completes. */
  served(source: string | null = null, moved: number | null = null): void {
    this.completed = true
    this.source = source
    this.bytes = moved
  }
}

/**
 * One path a command reports, before its output is rendered.
 *
 * A line spanning mounts renders every mount's records as one output: find's
 * actions run over every match, du's rows derive from every file counted, wc
 * lays every row out with one width and one total. `run` is the start point
 * or operand it belongs to, in operand order, so a nested or repeated start
 * point stays its own traversal (GNU walks each to completion before the
 * next); `size` du's bytes for a file it counted, absent for a directory its
 * walk met, the operand's own included; `values` wc's counts for the row, in
 * GNU's column order.
 */
export interface PathRecord {
  readonly path: PathSpec
  readonly run: number
  readonly size?: number
  readonly values?: readonly number[]
}

/** The live pipe a `PipeStream` reads, for a descriptor reading on after it. Mirrors Python's PipeEnd. */
export interface PipeEnd {
  stream(path: PathSpec, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/**
 * How a writer answers its stdout's reader going away instead of dying of
 * SIGPIPE (`tee -p`): what it says, and its status, null to keep its own.
 * Mirrors Python's ClosedPipe.
 */
export interface ClosedPipe {
  readonly stderr: Uint8Array
  readonly exitCode: number | null
}

/** A row a command hands over: it names the path it shows. Mirrors Python's PathRow. */
export interface PathRow {
  readonly path: PathSpec
}

/**
 * A command's output as rows, each naming the path it shows, and the renderer
 * that prints them.
 *
 * The command boundary drops every row whose path the session hides, by the
 * rule the dispatcher refuses a call by, and renders the rest, so nothing the
 * renderer prints (a name, a count, a total, a column width) stands for a
 * hidden path, and no handler checks a hide of its own. A handler hands them
 * over on `IOResult.rows` with no stdout; the renderer runs inside the
 * command's timeout and returns null to print nothing. Mirrors Python's Rows.
 */
export interface Rows<R extends PathRow = PathRow> {
  readonly items: readonly R[]
  render(shown: R[]): Promise<ByteSource | null>
}

export interface IOResultInit {
  stdout?: ByteSource | null
  stderr?: ByteSource | null
  exitCode?: number
  producer?: Producer | null
  records?: PathRecord[] | null
  refusal?: Refusal | null
  closedStdout?: ClosedPipe | null
  rows?: Rows | null
}

export class IOResult {
  // What the command found before it is rendered, for commands whose output
  // a later step renders again (find's actions, a line spanning mounts):
  // find's matches, du's files and directories, wc's rows without the total,
  // in operand order; null when the command supplied none.
  records: PathRecord[] | null
  // The command's output before it is rendered, handed over in place of
  // stdout: the command boundary drops the rows the session cannot see and
  // renders the rest. Never merged: the boundary consumes it.
  rows: Rows | null
  stdout: ByteSource | null
  stderr: ByteSource | null
  private _exitCode: number
  // Provenance of this result (which command, spanning which
  // mounts); merge keeps the last command for attribution, not
  // ownership of every byte in a combined result. The workspace boundary hands it to the
  // policy layer as context. Facts ride the envelope as policy
  // input; the decision a chain hands down rides beside them as
  // `refusal`, written after the last method has spoken.
  output: OutputState | null = null
  outputFinalized = false
  producer: Producer | null
  // Why the line did not run, when a policy or an unanswered ask
  // refused it; null on every ordinary run. stderr stays in bash's
  // voice, this carries the reason. merge keeps the rightmost record,
  // as it does the producer.
  refusal: Refusal | null
  // How the command answers its stdout's reader going away when it does so
  // itself (`tee -p`); null leaves the writer to SIGPIPE. merge keeps the
  // right-hand one, whose stdout the result carries.
  closedStdout: ClosedPipe | null
  streamSource: IOResult | null

  constructor(init: IOResultInit = {}) {
    this.records = init.records ?? null
    this.rows = init.rows ?? null
    this.stdout = init.stdout ?? null
    this.stderr = init.stderr ?? null
    this._exitCode = init.exitCode ?? 0
    this.producer = init.producer ?? null
    this.refusal = init.refusal ?? null
    this.closedStdout = init.closedStdout ?? null
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
    const source = this.stdout
    const bytes = await materialize(source)
    if (this.stdout === source) this.stdout = bytes
    return bytes
  }

  async stdoutStr(errors: 'replace' | 'strict' = 'replace'): Promise<string> {
    return decodeBytes(await this.materializeStdout(), errors)
  }

  async materializeStderr(): Promise<Uint8Array> {
    const source = this.stderr
    const bytes = await materialize(source)
    if (this.stderr === source) this.stderr = bytes
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
      records: other.records,
      stderr: mergedStderr,
      producer: other.producer,
      refusal: other.refusal ?? this.refusal,
      closedStdout: other.closedStdout,
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
