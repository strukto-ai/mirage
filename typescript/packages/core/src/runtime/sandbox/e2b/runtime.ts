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

import { abortable } from '../../../utils/abort.ts'
import { RemoteSandbox } from '../base.ts'
import { registerRuntime } from '../../table.ts'
import type { PipeWriter, RunResult, SandboxPipe } from '../../types.ts'
import type { RuntimeOptions } from '../../config.ts'
import { concat } from '../../../utils/bytes.ts'
import { requireId } from '../config.ts'
import { PTY_MARK, PTY_RAW } from './constants.ts'
import { loadSdk, type E2bSdk } from './sdk.ts'
import { E2B_CONFIG_KEYS, type E2BConfig } from './config.ts'
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
 * An E2B sandbox the user runs as a whole-line runtime.
 *
 * You create the sandbox yourself (`e2b sandbox spawn` or the SDK);
 * mirage only connects by `sandboxId` and execs lines. `apiKey` falls
 * back to E2B_API_KEY. E2B's exec reports stdout and stderr
 * separately. Piped bytes use native stdin followed by an explicit
 * EOF; no input closes stdin when the command starts. A `mountType`
 * serves the workspace over a PTY, since E2B's exec decodes output as
 * text.
 */
export class E2BRuntime extends RemoteSandbox<E2BConfig> {
  readonly name = 'e2b'
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RuntimeOptions<E2BConfig> = {}) {
    super(options, E2B_CONFIG_KEYS)
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

  override async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted()
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const sdk = await this.ensureSdk()
    signal?.throwIfAborted()
    // Keep the startup result even if aborted in flight, so its process can be killed.
    const handle = await this.sandbox.commands.run(line, {
      envs: env,
      cwd,
      background: true,
      stdin: stdin !== null,
    })
    let result: Pick<CommandResult, 'stdout' | 'stderr' | 'exitCode'>
    try {
      signal?.throwIfAborted()
      try {
        if (stdin !== null) {
          if (stdin.byteLength > 0) await abortable(handle.sendStdin(stdin), signal)
          await abortable(handle.closeStdin(), signal)
        }
      } catch (error) {
        // The command may exit before the input RPC arrives. Wait for its
        // real exit status rather than reporting the missing process as I/O.
        // Process RPCs still throw this SDK class; no process-specific replacement exists.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        if (!(error instanceof sdk.NotFoundError)) throw error
      }
      result = await abortable(handle.wait(), signal)
      signal?.throwIfAborted()
    } catch (error) {
      if (!signal?.aborted && error instanceof sdk.CommandExitError) {
        result = error
      } else {
        try {
          await handle.kill()
        } catch (cleanupError) {
          console.warn('Failed to stop the E2B command', cleanupError)
        }
        if (signal?.aborted) throw new DOMException('execute aborted', 'AbortError')
        throw error
      }
    } finally {
      await handle.disconnect()
    }
    return {
      stdout: ENC.encode(result.stdout),
      stderr: ENC.encode(result.stderr),
      exitCode: result.exitCode,
    }
  }

  override async openPipe(command: string): Promise<SandboxPipe> {
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

registerRuntime('e2b', E2BRuntime)
