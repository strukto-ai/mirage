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

import { DevicePipe } from '../../core/dev/pipe.ts'
import type { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { PipeClosed } from '../../io/errors.ts'
import { materialize, type ByteSource, type IOResult } from '../../io/types.ts'
import { Channel, JobConsole, Terminal } from '../../shell/console/index.ts'
import { getProcessSubBody, getProcessSubDirection } from '../../shell/helpers.ts'
import { ProcessSubDirection, type TSNodeLike } from '../../shell/types.ts'
import { joinOrAbort, makeAbortError, mergeSignals } from '../../utils/abort.ts'
import { concat } from '../../utils/bytes.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import type { EvaluationContext } from '../evaluation.ts'
import type { ProcessSubLine } from '../frame.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { ExecutionNode } from '../types.ts'
import type { Substitution } from './types.ts'

class SubstitutionConsole extends JobConsole {
  constructor(
    private readonly endpoint: DevicePipe,
    private readonly target: JobConsole,
    private readonly abort: AbortController,
  ) {
    super()
  }
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.abort.signal.aborted) return
    if (channel === Channel.STDOUT && this.endpoint.readable) {
      try {
        await this.endpoint.pipe.write(data)
      } catch (error) {
        if (!(error instanceof PipeClosed)) throw error
        this.abort.abort()
        throw makeAbortError(this.abort.signal)
      }
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
  private readonly capture = new Terminal()
  private closing: Promise<void> | undefined

  constructor(
    private readonly context: EvaluationContext,
    private readonly registry: MountRegistry,
    private readonly sink?: JobConsole,
    private readonly signal?: AbortSignal,
  ) {}

  open = (node: TSNodeLike, executeLine: ProcessSubLine): Promise<string> => {
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
    const output = new SubstitutionConsole(endpoint, this.sink ?? this.capture, abort)
    // The line starts once the command naming it has, as bash's forked child
    // does and Python's task does: a consumer that reads nothing must not
    // close its pipe before the command's first write lands.
    child.task = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() =>
        executeLine(getProcessSubBody(node), {
          sink: output,
          signal,
          ...(endpoint.readable ? {} : { stdin: endpoint.pipe.stream() }),
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
        if (signal.aborted)
          console.error('process substitution failed after cancellation', child.failure)
      })
      .finally(() => {
        if (endpoint.readable) endpoint.pipe.end(child.failure)
        else endpoint.pipe.closeReader()
      })
    this.held.push(child)
    return Promise.resolve(path)
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
        child.abort.abort()
      } else child.endpoint.pipe.end()
    }
    try {
      await Promise.all([
        ...[...kept.values()].flat().map((lines) => lines.loadRest()),
        ...this.held.map(async (child) => {
          try {
            await joinOrAbort(child.task, child.signal)
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

  /**
   * End the substitutions as a finished command does, for a node `exit`,
   * `return` or `break` leaves, and return what they wrote to the capture,
   * stdout then stderr. Mirrors Python's settle.
   */
  async settle(): Promise<[Uint8Array, Uint8Array]> {
    await this.close()
    return this.capture.take()
  }

  own(stdout: ByteSource | null, io: IOResult, node: ExecutionNode): ByteSource | null {
    return this.held.length === 0 ? stdout : this.output(stdout, io, node)
  }

  private async *output(
    stdout: ByteSource | null,
    io: IOResult,
    node: ExecutionNode,
  ): AsyncGenerator<Uint8Array> {
    let completed = false
    try {
      if (stdout instanceof Uint8Array) {
        if (stdout.byteLength > 0) yield stdout
      } else if (stdout !== null) yield* stdout
      completed = true
    } finally {
      await this.close(!completed)
      const [out, err] = this.capture.take()
      if (err.byteLength > 0) {
        io.stderr = concat([await materialize(io.stderr), err])
        node.stderr = io.stderr
      }
      if (completed && out.byteLength > 0) yield out
    }
  }
}
