import { closeQuietly } from './stream.ts'
import { concat } from '../utils/bytes.ts'
import { abortable, joinOrAbort } from '../utils/abort.ts'
import { chunks } from './cooperative.ts'
import { OutputPipe } from './output.ts'
import { CAPACITY } from './pipe.ts'
import {
  IOResult,
  OutputState,
  type ByteSource,
  type CommandOutput,
  type HandlerResult,
  type StreamName,
} from './types.ts'

/** An asynchronous byte destination owned by its invocation. */
export interface ByteWriter {
  write(data: Uint8Array): Promise<void>
}

/** A handler's input, asynchronous output, and cancellation lifetime. */
export class Stdio {
  readonly stdin: AsyncIterable<Uint8Array>
  readonly stdout: ByteWriter
  readonly stderr: ByteWriter
  readonly pipe: OutputPipe
  private readonly controller = new AbortController()
  private ready!: () => void
  isPublished = false
  readonly published = new Promise<void>((resolve) => {
    this.ready = resolve
  })
  writing = false

  constructor(stdin: ByteSource | null = null, bufferBytes: number = CAPACITY) {
    this.pipe = new OutputPipe(bufferBytes)
    this.stdin = chunks(stdin ?? new Uint8Array(), this.signal)
    this.stdout = { write: (data) => this.write('stdout', data) }
    this.stderr = { write: (data) => this.write('stderr', data) }
  }

  publish(): void {
    this.isPublished = true
    this.ready()
  }

  get cancelled(): boolean {
    return this.signal.aborted
  }
  get signal(): AbortSignal {
    return this.controller.signal
  }

  async waitCancelled(): Promise<void> {
    if (this.cancelled) return
    await new Promise<void>((resolve) => {
      this.signal.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true },
      )
    })
  }

  private async write(stream: StreamName, data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return
    this.writing = true
    this.publish()
    await this.pipe.write(stream, data)
  }

  cancel(): void {
    this.controller.abort()
    this.pipe.closeReader()
  }
}

/** Own producer cleanup even when its byte iterator was never started. */
export class OutputStream implements AsyncIterableIterator<Uint8Array> {
  constructor(
    private readonly source: AsyncIterator<Uint8Array>,
    private readonly close: () => Promise<void>,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }
  next(): Promise<IteratorResult<Uint8Array>> {
    return this.source.next()
  }
  async return(): Promise<IteratorResult<Uint8Array>> {
    await this.close()
    return (await this.source.return?.()) ?? { done: true, value: undefined }
  }
}

function copyResult(io: IOResult, outcome: IOResult): void {
  io.streamSource = outcome
  io.matchedRuns = outcome.matchedRuns
  io.sizedRuns = outcome.sizedRuns
  io.countedRuns = outcome.countedRuns
  io.refusal = outcome.refusal
}

/** Publish one admitted handler and own all of its output and cleanup. */
export async function invoke(
  run: (stdio: Stdio) => HandlerResult | Promise<HandlerResult>,
  stdin: ByteSource | null = null,
  signal?: AbortSignal,
  bufferBytes: number = CAPACITY,
): Promise<CommandOutput | null> {
  const stdio = new Stdio(stdin, bufferBytes)
  const io = new IOResult()
  const state = new OutputState()
  io.output = state
  let read!: () => void
  const reading = new Promise<void>((resolve) => {
    read = resolve
  })
  const publication: { declined: boolean; failure: { error: unknown } | null } = {
    declined: false,
    failure: null,
  }
  const cancel = (): void => {
    stdio.cancel()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted === true) cancel()
  async function pump(stream: StreamName, returned: ByteSource): Promise<void> {
    for await (const data of chunks(returned, stdio.signal)) {
      await stdio.pipe.write(stream, data)
      await stdio.pipe.drain()
      if (stdio.cancelled) return
    }
  }
  const task = (async (): Promise<void> => {
    let source: ByteSource | null = null
    let stderr: ByteSource | null = null
    let outcome: IOResult | null = null
    let stderrStarted = false
    try {
      const result = await run(stdio)
      publication.declined = result === null && !stdio.writing
      const [returned, resultIO] =
        result instanceof IOResult ? [result.stdout, result] : (result ?? [null, new IOResult()])
      outcome = resultIO
      source = returned
      stderr = outcome.stderr
      copyResult(io, outcome)
      if (
        (source === null || source instanceof Uint8Array) &&
        (stderr === null || stderr instanceof Uint8Array)
      ) {
        await closeQuietly(stdio.stdin)
      }
      stdio.publish()
      if (source !== null || stderr !== null) {
        await abortable(reading, stdio.signal)
        const streams: StreamName[] = ['stdout', 'stderr']
        for (const stream of streams) {
          const returned = stream === 'stdout' ? source : outcome.stderr
          if (stream === 'stderr') {
            stderrStarted = true
            stderr = returned
          }
          if (returned === null) continue
          await pump(stream, returned)
          if (stdio.cancelled) return
        }
      }
      copyResult(io, outcome)
      state.finish()
      stdio.pipe.end()
    } catch (error) {
      if (outcome !== null && !stderrStarted && stdio.isPublished && !stdio.cancelled) {
        stderr = outcome.stderr
        if (stderr !== null) {
          stderrStarted = true
          try {
            await pump('stderr', stderr)
          } catch (stderrError) {
            console.debug('handler stderr failed after stdout', stderrError)
          }
        }
      }
      if (!stdio.isPublished) publication.failure = { error }
      stdio.pipe.end(error)
      throw error
    } finally {
      await closeQuietly(source)
      await closeQuietly(stderr)
      await closeQuietly(stdio.stdin)
      const finalOutcome = outcome
      if (finalOutcome !== null && !state.settled) {
        if (stdio.cancelled && !stderrStarted && finalOutcome.stderr instanceof Uint8Array) {
          io.stderr = concat([await io.materializeStderr(), finalOutcome.stderr])
        }
        copyResult(io, finalOutcome)
        state.finish()
      }
      stdio.publish()
    }
  })()
  // A late failure also travels through the pipe after its accepted prefix.
  const settled = task.catch(() => undefined)
  async function close(): Promise<void> {
    cancel()
    await joinOrAbort(settled, stdio.signal).catch((error: unknown) => {
      console.debug('handler outlived its cancellation grace', error)
    })
    await closeQuietly(stdio.stdin)
    signal?.removeEventListener('abort', cancel)
  }
  try {
    await abortable(stdio.published, signal)
    if (publication.failure !== null) throw publication.failure.error
    if (publication.declined) {
      await task
      signal?.removeEventListener('abort', cancel)
      return null
    }
  } catch (error) {
    cancel()
    await close()
    throw error
  }

  async function* output(): AsyncGenerator<Uint8Array> {
    const stderr: Uint8Array[] = []
    read()
    try {
      for await (const event of stdio.pipe.events()) {
        if (event.stream === 'stderr') {
          if (state.stderr !== null) await state.stderr(event.data)
          else stderr.push(event.data)
        } else yield event.data
      }
      await task
    } finally {
      if (stderr.length > 0) io.stderr = concat([await io.materializeStderr(), ...stderr])
      await close()
    }
  }
  return [new OutputStream(output(), close), io]
}
