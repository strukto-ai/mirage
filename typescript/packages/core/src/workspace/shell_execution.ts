import { makeAbortError } from '../concurrency/limiter.ts'
import { concat } from '../io/cachable_iterator.ts'
import { OutputPipe } from '../io/output.ts'
import { CAPACITY } from '../io/pipe.ts'
import type { OutputEvent } from '../io/types.ts'
import { JobConsole } from '../shell/console/job_console.ts'
import { Channel } from '../shell/console/types.ts'
import { PipeClosed } from '../io/errors.ts'
import type { ExecutionScope } from './execution.ts'
import { ExecuteResult } from './workspace/types.ts'

class ShellOutput extends JobConsole {
  readonly pipe: OutputPipe

  constructor(bufferBytes: number) {
    super()
    this.pipe = new OutputPipe(bufferBytes)
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (channel === Channel.CONTROL) return
    await this.pipe.write(channel, data)
  }
}

class ShellEvents implements AsyncIterableIterator<OutputEvent> {
  private readonly source: AsyncGenerator<OutputEvent>
  private ended = false
  private pulling = false

  constructor(
    private readonly owner: ShellExecution,
    private readonly output: ShellOutput,
  ) {
    this.source = output.pipe.events()
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<OutputEvent> {
    return this
  }

  async next(): Promise<IteratorResult<OutputEvent>> {
    if (this.ended) return { done: true, value: undefined }
    if (this.pulling) throw new Error('shell events already have a pending reader')
    this.pulling = true
    try {
      const next = await this.source.next()
      if (this.output.pipe.closedReader || next.done) {
        this.ended = true
        return { done: true, value: undefined }
      }
      return next
    } catch (error) {
      this.owner.cancel()
      throw error
    } finally {
      this.pulling = false
    }
  }

  async return(): Promise<IteratorResult<OutputEvent>> {
    await this.owner.close()
    return { done: true, value: undefined }
  }

  async release(): Promise<void> {
    this.ended = true
    this.output.pipe.closeReader()
    await this.source.return(undefined)
  }
}

/** A shell invocation and bounded single-reader events. Drain events before wait(). */
export class ShellExecution {
  readonly id: string
  readonly events: ShellEvents
  private readonly controller = new AbortController()
  private readonly output: ShellOutput
  private readonly result: Promise<ExecuteResult>
  private closing?: Promise<void>
  private settled = false

  constructor(
    run: (sink: JobConsole, signal: AbortSignal, scope: ExecutionScope) => Promise<ExecuteResult>,
    scope: ExecutionScope,
    signal?: AbortSignal,
    bufferBytes = CAPACITY,
  ) {
    this.id = scope.id
    this.output = new ShellOutput(bufferBytes)
    this.output.bindExecution(this.id)
    this.events = new ShellEvents(this, this.output)
    const combined =
      signal === undefined
        ? this.controller.signal
        : AbortSignal.any([signal, this.controller.signal])
    this.result = this.run(run, scope, combined)
    // The outcome is delivered by wait()/events even when a consumer closes before its first pull.
    void this.result.catch(() => undefined)
  }

  private async run(
    run: (sink: JobConsole, signal: AbortSignal, scope: ExecutionScope) => Promise<ExecuteResult>,
    scope: ExecutionScope,
    signal: AbortSignal,
  ): Promise<ExecuteResult> {
    try {
      if (signal.aborted) throw makeAbortError(signal)
      const result = await run(this.output, signal, scope)
      this.output.pipe.end()
      return result
    } catch (error) {
      const failure = signal.aborted && error instanceof PipeClosed ? makeAbortError(signal) : error
      this.output.pipe.end(failure)
      throw failure
    } finally {
      this.settled = true
    }
  }

  /** @internal Release workspace registration when invocation settles. */
  onSettled(callback: () => void): void {
    void this.result.then(callback, callback)
  }

  cancel(): void {
    if (!this.settled) {
      this.controller.abort(new DOMException('execute aborted', 'AbortError'))
      this.output.pipe.end(this.controller.signal.reason)
    }
  }

  /** Join the invocation; final stdout/stderr are empty because events delivered them. */
  wait(): Promise<ExecuteResult> {
    return this.result
  }

  /** Collect output and await an optional observer before the next pull. */
  async collect(onEvent?: (event: OutputEvent) => Promise<void>): Promise<ExecuteResult> {
    const stdout: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    try {
      for await (const event of this.events) {
        ;(event.stream === Channel.STDOUT ? stdout : stderr).push(event.data)
        await onEvent?.(event)
      }
      const result = await this.wait()
      return new ExecuteResult(concat(stdout), concat(stderr), result.exitCode, result.refusal)
    } finally {
      await this.close()
    }
  }

  /** Discard unread output, cancel and join under the shell's normal cancellation policy. */
  close(): Promise<void> {
    this.closing ??= this.closeOwned()
    return this.closing
  }

  private async closeOwned(): Promise<void> {
    this.cancel()
    await this.events.release()
    await Promise.allSettled([this.result])
    await this.output.close()
  }
}
