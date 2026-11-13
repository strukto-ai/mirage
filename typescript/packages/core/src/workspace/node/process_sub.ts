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

import type { JobTable } from '../../execution/job/table.ts'
import type { Hold } from '../../execution/job/waits.ts'
import { DevicePipe } from '../../core/dev/pipe.ts'
import { FD_STDOUT } from '../../shell/constants.ts'
import type { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import type { BytePipe } from '../../io/pipe.ts'
import { PipeClosed } from '../../io/errors.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { Channel, JobConsole } from '../../shell/console/index.ts'
import { retainPrograms } from '../../shell/parse/program.ts'
import { getProcessSubBody, getProcessSubDirection } from '../../shell/helpers.ts'
import { ProcessSubDirection, type TSNodeLike } from '../../shell/types.ts'
import { runCancellable, mergeSignals } from '../../utils/abort.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { captureHold, jobStreams } from '../executor/background.ts'
import { ForkRoute } from '../executor/builtins/exec/index.ts'
import type { ProcessSubLine } from '../frame.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Substitution } from './types.ts'

class SubstitutionConsole extends JobConsole {
  constructor(
    private readonly endpoint: DevicePipe,
    private readonly target: JobConsole,
    private readonly abort: AbortController,
  ) {
    super()
  }

  override pipeFor(channel: Channel): BytePipe | null {
    return channel === Channel.STDOUT && this.endpoint.readable
      ? this.endpoint.pipe
      : this.target.pipeFor(channel)
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.abort.signal.aborted) return
    if (channel === Channel.STDOUT && this.endpoint.readable) {
      await this.endpoint.pipe.write(data)
    } else await this.target.emit(channel, data)
  }
}

/**
 * Close the streams readers opened on a pipe that ends with its command: a
 * later read finds the end of input either way, and nothing is left open.
 * Mirrors Python's _close_readers.
 */
async function closeReaders(endpoint: DevicePipe): Promise<void> {
  const readers = [...endpoint.readers]
  endpoint.readers.clear()
  for (const reader of readers) await reader.deref()?.close()
}

/** Own the virtual descriptors and auxiliary children of one command node. */
export class ProcessSubScope {
  private readonly held: Substitution[] = []
  private closing: Promise<void> | undefined

  constructor(
    private readonly context: EvaluationContext,
    private readonly registry: MountRegistry,
    private readonly jobs: JobTable,
    private readonly signal?: AbortSignal,
  ) {}

  open = async (node: TSNodeLike, executeLine: ProcessSubLine): Promise<string> => {
    const [root] = this.registry.resolve('/dev/null')
    if (!(root instanceof DevVFS)) throw new Error('missing device filesystem')
    const dev = root.forSession(this.context.session.sessionId)
    const endpoint = new DevicePipe(getProcessSubDirection(node) !== ProcessSubDirection.OUTPUT)
    const [path, allocation] = dev.allocateInput(endpoint)
    const abort = new AbortController()
    const signal =
      mergeSignals(this.signal ?? this.context.frame.abortSignal ?? undefined, abort.signal) ??
      abort.signal
    const child: Substitution = {
      dev,
      path,
      allocation,
      endpoint,
      abort,
      signal,
      task: Promise.resolve(),
    }
    const session = this.context.session
    // A producer is a child of the shell, as bash forks it: what it writes
    // past its pipe goes where that shell's jobs write, into the statement
    // running then or, once that has ended, on out.
    const jobs = new ForkRoute(session.jobOutput ?? session.tty.jobs, session)
    const output = new SubstitutionConsole(endpoint, jobs, abort)
    const writers = this.context.frame.writers
    const holds: Hold[] = []
    let begin = (): void => undefined
    const begun = new Promise<void>((resolve) => {
      begin = resolve
    })
    const release = retainPrograms([node])
    // The line starts once the command naming it has, as bash's forked child
    // does and Python's task does: a consumer that reads nothing must not
    // close its pipe before the command's first write lands.
    child.task = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() =>
        executeLine(getProcessSubBody(node), {
          sink: output,
          signal,
          ...(endpoint.readable ? {} : { stdin: endpoint.pipe.stream() }),
          started: (process, shell) => {
            const pid = process.record.id.pid
            if (endpoint.readable) writers.push([path, pid])
            session.lastBgJobId = pid
            this.jobs.trackSubstitution(process)
            shell.holds.push(...holds)
            begin()
          },
        }),
      )
      .then(async (io) => {
        await output.emit(Channel.STDOUT, await materialize(io.stdout))
        await output.emit(Channel.STDERR, await materialize(io.stderr))
      })
      .catch((error: unknown) => {
        // Closing the command's reader intentionally interrupts its producer.
        if (signal.aborted && error instanceof Error && error.name === 'AbortError') return
        if (error instanceof PipeClosed && endpoint.pipe.closedReader) return
        child.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
        console.debug('process substitution failed', child.failure)
      })
      .finally(() => {
        begin()
        release()
        if (endpoint.readable) endpoint.pipe.end(child.failure)
        else endpoint.pipe.closeReader()
      })
    this.held.push(child)
    // Like a job, it holds open a capture (`$( )`, a pipe stage) one of its
    // streams leads into, which waits for it until it ends or its shell
    // points them elsewhere.
    const streams = jobStreams(node, session)
    if (endpoint.readable) streams.delete(FD_STDOUT)
    const hold =
      session.jobWaits === null
        ? null
        : captureHold(session.jobWaits, jobs, streams, session, () => child.task)
    if (hold !== null) holds.push(hold)
    // A `<( )` the command reads has started before the command does, as bash
    // forks it, so the command's program knows the process writing the path.
    if (endpoint.readable) await begun
    if (child.failure !== undefined) throw child.failure
    return path
  }

  close(failed = false): Promise<void> {
    this.closing ??= this.finish(failed)
    return this.closing
  }

  private async finish(failed: boolean): Promise<void> {
    const held = this.heldInputs()
    const kept = failed ? new Map<string, AsyncLineIterator[]>() : held
    for (const child of this.held) {
      if (kept.has(child.path)) continue
      if (failed || child.endpoint.readable) {
        child.endpoint.pipe.closeReader()
        if (failed) child.abort.abort()
      } else child.endpoint.pipe.end()
    }
    try {
      await Promise.all([
        ...[...kept.values()].flat().map((lines) => lines.loadRest()),
        ...this.held
          .filter((child) => failed || kept.has(child.path) || !child.endpoint.readable)
          .map(async (child) => {
            try {
              await runCancellable(child.task, child.signal)
            } catch (error) {
              // A join the caller cut short leaves the child to settle on its
              // own; its late output must not reach a console the caller left.
              child.abort.abort()
              if (!child.signal.aborted) throw error
            }
            if (child.failure !== undefined) throw child.failure
          }),
      ])
    } finally {
      for (const child of this.held) {
        await closeReaders(child.endpoint)
        child.dev.releaseInput(child.path, child.allocation)
      }
    }
  }

  /**
   * This scope's input pipes that a shell descriptor still reads after the
   * command (`exec 3<"$1"`, or a dup), with the line buffers reading each,
   * which load the rest. The descriptors stop naming them, as the paths are
   * free once this command ends. Mirrors Python's _held_inputs.
   */
  private heldInputs(): Map<string, AsyncLineIterator[]> {
    const inputs = new Set(this.held.filter((c) => c.endpoint.readable).map((c) => c.path))
    const held = new Map<string, AsyncLineIterator[]>()
    for (const descriptor of this.context.session.descriptors.values()) {
      const source = descriptor.source
      if (source?.pipe == null || !inputs.has(source.pipe.virtual)) continue
      const readers = held.get(source.pipe.virtual) ?? []
      if (!readers.includes(source.lines)) readers.push(source.lines)
      held.set(source.pipe.virtual, readers)
      source.pipe = null
    }
    return held
  }

  own(stdout: ByteSource | null): ByteSource | null {
    return this.held.length === 0 ? stdout : this.output(stdout)
  }

  private async *output(stdout: ByteSource | null): AsyncGenerator<Uint8Array> {
    let completed = false
    try {
      if (stdout instanceof Uint8Array) {
        if (stdout.byteLength > 0) yield stdout
      } else if (stdout !== null) yield* stdout
      completed = true
    } finally {
      await this.close(!completed)
    }
  }
}
