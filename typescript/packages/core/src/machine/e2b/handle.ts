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

import { feed } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { abortable } from '../../utils/abort.ts'
import { currentCaller } from '../../context/session_context.ts'
import { MachineHandle } from '../handle.ts'
import { PIPE_TRANSPORT, type PipeTransport } from '../mixin.ts'
import { registerMachine } from '../registry.ts'
import type { MachinePipe } from '../types.ts'
import type { OutputFn, PipeWriter, RunResult } from '../../runtime/types.ts'
import type { ConfigFields } from '../../runtime/config.ts'
import { concat } from '../../utils/bytes.ts'
import { requireId } from '../config.ts'
import {
  decodeOutput,
  encodeOutput,
  isRun,
  PROCESS,
  runTag,
  stopSignal,
  wrapLine,
} from '../constants.ts'
import { CLOSED_INPUT, PTY_MARK, PTY_RAW } from './constants.ts'
import { loadSdk, type E2bSdk } from './sdk.ts'
import { E2B_CONFIG_FIELDS, type E2BConfig } from './config.ts'
import type { CommandResult, Sandbox } from 'e2b'

const ENC = new TextEncoder()

/** Where the PTY marker ends in `bytes`, or -1 while it has not come. */
function pastMark(bytes: Uint8Array): number {
  outer: for (let at = 0; at + PTY_MARK.length <= bytes.length; at++) {
    for (let i = 0; i < PTY_MARK.length; i++) {
      if (bytes[at + i] !== PTY_MARK[i]) continue outer
    }
    return at + PTY_MARK.length
  }
  return -1
}

/**
 * The bytes in output an `encodeOutput` command streams, decoded a whole
 * line at a time as its text arrives.
 */
class LineDecoder {
  private held = ''

  feed(text: string): Uint8Array {
    const all = this.held + text
    const cut = all.lastIndexOf('\n')
    this.held = all.slice(cut + 1)
    return decodeOutput(all.slice(0, Math.max(cut, 0)))
  }

  flush(): Uint8Array {
    const held = this.held
    this.held = ''
    return decodeOutput(held)
  }
}

/**
 * A PTY's stdin as a pipe writer. Writes queue, and one loop sends what
 * has queued in one E2B call, in order: each call is a round trip, so a
 * reply split into many writes would otherwise cost one trip per write.
 * A send that fails hands its error to `fail` and sends nothing more.
 */
class PtyWriter implements PipeWriter {
  private queue: Uint8Array[] = []
  private ended = false
  private wake: (() => void) | null = null

  constructor(
    private readonly send: (data: Uint8Array) => Promise<void>,
    private readonly fail: (err: unknown) => Promise<void>,
  ) {
    void this.loop()
  }

  write(data: Uint8Array): void {
    this.queue.push(data.slice())
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.queue.length === 0) {
        if (this.ended) return
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        this.wake = null
        continue
      }
      const chunks = this.queue
      this.queue = []
      try {
        await this.send(concat(chunks))
      } catch (err) {
        await this.fail(err)
        return
      }
    }
  }
}

/**
 * A running E2B sandbox, reached through its SDK.
 *
 * You create the machine yourself (`e2b sandbox spawn` or the SDK);
 * mirage only connects by `sandboxId` and execs lines. `apiKey` falls
 * back to E2B_API_KEY. E2B's exec reports stdout and stderr
 * separately, stdout as it arrives when streamed, each base64-encoded in
 * the machine since the exec decodes output as text (`encodeOutput`: the
 * sandbox needs dd and base64). Piped bytes use native
 * stdin, chunk by chunk, followed by an explicit EOF; no input closes
 * stdin when the command starts. The SDK's own command timeout is off: a
 * command runs until mirage's limits stop it. A `mountType` serves the
 * workspace over a PTY, since E2B's exec decodes output as text.
 */
export class E2BMachine extends MachineHandle<E2BConfig> implements PipeTransport {
  static override readonly configFields: ConfigFields = E2B_CONFIG_FIELDS
  readonly [PIPE_TRANSPORT] = true as const
  static override readonly provider = 'e2b'
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null

  constructor(name: string, config?: E2BConfig) {
    super(name, config, E2BMachine.configFields)
    requireId('e2b', 'sandboxId', this.config.sandboxId)
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<E2bSdk> {
    return loadSdk()
  }

  private async ensureSdk(): Promise<E2bSdk> {
    this.sdk ??= await this.loadSdk()
    return this.sdk
  }

  private apiParams(): Record<string, unknown> {
    return this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}
  }

  async connect(): Promise<void> {
    const sdk = await this.ensureSdk()
    this.sandbox = await sdk.Sandbox.connect(this.config.sandboxId, this.apiParams())
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted()
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const runner = currentCaller().process
    const sdk = await this.ensureSdk()
    signal?.throwIfAborted()
    // Keep the startup result even if aborted in flight, so its process can be killed.
    const out = new LineDecoder()
    const err = new LineDecoder()
    const decoding =
      (sink: OutputFn, decoder: LineDecoder) =>
      async (text: string): Promise<void> => {
        const data = decoder.feed(text)
        if (data.byteLength > 0) await sink(data)
      }
    const handle = await this.sandbox.commands.run(encodeOutput(wrapLine(argv, env, cwd)), {
      background: true,
      stdin: stdin !== null,
      timeoutMs: 0,
      ...(output !== null ? { onStdout: decoding(output, out) } : {}),
      ...(errors !== null ? { onStderr: decoding(errors, err) } : {}),
    })
    let result: Pick<CommandResult, 'stdout' | 'stderr' | 'exitCode'>
    const state = { exited: false }
    const write = async (chunk: Uint8Array): Promise<void> => {
      if (chunk.byteLength > 0) await abortable(handle.sendStdin(chunk), signal)
    }
    const end = async (): Promise<void> => {
      if (stdin !== null) await abortable(handle.closeStdin(), signal)
    }
    // The command may exit before the input RPC arrives, or close its
    // input while it runs (head). Wait for its real exit status rather
    // than reporting either as I/O.
    const closed = (error: unknown): boolean =>
      (error instanceof sdk.SandboxError &&
        CLOSED_INPUT.some((message) => error.message.includes(message))) ||
      // Process RPCs still throw this SDK class; no process-specific replacement exists.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      error instanceof sdk.NotFoundError
    try {
      signal?.throwIfAborted()
      // The command may end without reading all its input (head), so its
      // exit, not the end of the input, ends the line: a pull still waiting
      // on input that stays open is left to stop at its next chunk.
      const feeding = feed(stdin, write, end, () => state.exited, closed)
      feeding.catch((error: unknown) => {
        if (state.exited) console.debug(`e2b input after the command ended: ${String(error)}`)
      })
      const finished = abortable(handle.wait(), signal)
      try {
        result = await Promise.race([finished, feeding.then(() => finished)])
      } finally {
        state.exited = true
      }
      signal?.throwIfAborted()
    } catch (error) {
      if (!signal?.aborted && error instanceof sdk.CommandExitError) {
        result = error
      } else {
        try {
          // A tagged command a kill stopped with a gentler signal is left
          // to the caller's stop, which sends it that signal first.
          if ((env[PROCESS] === undefined && !isRun(argv)) || stopSignal(runner) === null)
            await handle.kill()
        } catch (cleanupError) {
          console.warn('Failed to stop the E2B command', cleanupError)
        }
        if (signal?.aborted) throw new DOMException('execute aborted', 'AbortError')
        // The kill stops only the encoding shell; the caller stops an abort.
        const tag = isRun(argv) ? runTag(argv) : env[PROCESS]
        if (tag !== undefined) await this.stop(tag, 15)
        throw error
      }
    } finally {
      await handle.disconnect()
    }
    const [outTail, errTail] = [out.flush(), err.flush()]
    if (output !== null && outTail.byteLength > 0) await output(outTail)
    if (errors !== null && errTail.byteLength > 0) await errors(errTail)
    return {
      stdout: output === null ? decodeOutput(result.stdout) : new Uint8Array(),
      stderr: errors === null ? decodeOutput(result.stderr) : new Uint8Array(),
      exitCode: result.exitCode,
    }
  }

  /**
   * Execute one shell line, under a `PROCESS` tag of its own when the
   * caller gave none: an abort kills only the encoding shell, so an aborted
   * line is stopped by that tag.
   *
   * @param line the raw shell line.
   * @param stdin bytes piped into the line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param signal stops the line.
   */
  override async execLine(
    line: string,
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (env[PROCESS] !== undefined) return super.execLine(line, stdin, env, cwd, signal)
    const tag = crypto.randomUUID().replaceAll('-', '')
    try {
      return await super.execLine(line, stdin, { ...env, [PROCESS]: tag }, cwd, signal)
    } catch (error) {
      if (signal?.aborted === true) await this.stop(tag, 15)
      throw error
    }
  }

  async openPipe(command: string): Promise<MachinePipe> {
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const pty = this.sandbox.pty
    let feed: ReadableStreamDefaultController<Uint8Array> | null = null
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller
      },
    })
    let head: Uint8Array | null = new Uint8Array(0)
    const onData = (data: Uint8Array): void => {
      if (head === null) {
        feed?.enqueue(data.slice())
        return
      }
      head = concat([head, data])
      const past = pastMark(head)
      if (past < 0) return
      const rest = head.slice(past)
      head = null
      if (rest.byteLength > 0) feed?.enqueue(rest)
    }
    const handle = await pty.create({ cols: 80, rows: 24, onData, timeoutMs: 0 })
    let failed = false
    const fail = async (err: unknown): Promise<void> => {
      failed = true
      feed?.error(err)
      await stop().catch((stopErr: unknown) => {
        console.debug(`e2b: stopping the PTY for ${command} failed`, stopErr)
      })
    }
    const writer = new PtyWriter((data) => pty.sendInput(handle.pid, data), fail)
    let ended = false
    const waiting = handle
      .wait()
      .then(
        () => undefined,
        (err: unknown) => {
          console.debug(`e2b: the PTY for ${command} ended`, err)
        },
      )
      .finally(() => {
        ended = true
        if (!failed) feed?.close()
        writer.end()
      })
    const stop = async (): Promise<void> => {
      if (!ended) await pty.kill(handle.pid)
      await waiting
    }
    try {
      await pty.sendInput(handle.pid, ENC.encode(`${PTY_RAW}${command}\n`))
    } catch (err) {
      await stop().catch((stopErr: unknown) => {
        console.debug(`e2b: stopping the PTY for ${command} failed`, stopErr)
      })
      throw err
    }
    return { reader, writer, stop }
  }
}

registerMachine('e2b', E2BMachine)
