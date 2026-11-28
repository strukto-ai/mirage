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
import { MachineHandle, logger } from '../handle.ts'
import { PIPE_TRANSPORT, type PipeTransport } from '../mixin.ts'
import { registerMachine } from '../registry.ts'
import type { MachinePipe } from '../types.ts'
import type { OutputFn, PipeWriter, RunAnswer, RunResult } from '../../runtime/types.ts'
import type { ConfigFields } from '../../runtime/config.ts'
import { concat } from '../../utils/bytes.ts'
import { checkOnPause, requireId } from '../config.ts'
import { ConnectionLostError } from '../errors.ts'
import {
  decodeOutput,
  encodeOutput,
  isRun,
  notRunningHint,
  PIPE_UNSENT_BYTES,
  PROCESS,
  runTag,
  stopSignal,
  wrapLine,
} from '../constants.ts'
import {
  CLOSED_INPUT,
  DEFAULT_TEMPLATE,
  ON_PAUSE,
  PTY_MARK,
  PTY_RAW,
  BUSY_REFRESH_SECONDS,
  BUSY_TIMEOUT_SECONDS,
  IDLE_MARGIN_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  SANDBOX_GONE,
} from './constants.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import type { E2bSdk } from './sdk.ts'
import { E2BConfig } from './config.ts'
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
 * `drain` waits while more than PIPE_UNSENT_BYTES are queued or on their way.
 */
class PtyWriter implements PipeWriter {
  private queue: Uint8Array[] = []
  private ended = false
  private stopped = false
  private unsent = 0
  private wake: (() => void) | null = null
  private draining: (() => void)[] = []

  constructor(
    private readonly send: (data: Uint8Array) => Promise<void>,
    private readonly fail: (err: unknown) => Promise<void>,
  ) {
    void this.loop()
  }

  write(data: Uint8Array): void {
    this.unsent += data.byteLength
    this.queue.push(data.slice())
    this.wake?.()
  }

  async drain(): Promise<void> {
    while (this.unsent > PIPE_UNSENT_BYTES && !this.stopped) {
      await new Promise<void>((resolve) => {
        this.draining.push(resolve)
      })
    }
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  private sent(): void {
    const woken = this.draining
    this.draining = []
    for (const resolve of woken) resolve()
  }

  private async loop(): Promise<void> {
    try {
      await this.sendQueued()
    } finally {
      this.stopped = true
      this.sent()
    }
  }

  private async sendQueued(): Promise<void> {
    for (;;) {
      if (this.queue.length === 0) {
        if (this.ended) return
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        this.wake = null
        continue
      }
      const batch = concat(this.queue)
      this.queue = []
      try {
        await this.send(batch)
      } catch (err) {
        await this.fail(err)
        return
      }
      this.unsent -= batch.byteLength
      this.sent()
    }
  }
}

/**
 * An E2B sandbox, reached through its SDK.
 *
 * Yours, by `sandboxId` (`e2b sandbox spawn` or the SDK), or, without one,
 * a sandbox Mirage starts from `template` at the first run that needs it
 * and keeps in the workspace's memory: a later build connects to it again
 * (resuming it when paused), and one that is gone is started anew. Mirage
 * pauses a sandbox it started as the workspace closes and kills it as the
 * workspace is deleted. While Mirage has work there (a program's run or one
 * of its own lines) the sandbox's E2B timeout is `BUSY_TIMEOUT_SECONDS`,
 * pushed out every `BUSY_REFRESH_SECONDS`; once the work ends it is
 * `idleTimeout`, after which E2B pauses the sandbox itself, and the next
 * work resumes it. `apiKey` falls back to E2B_API_KEY. E2B's exec reports stdout and stderr
 * separately, stdout as it arrives when streamed, each base64-encoded in
 * the machine since the exec decodes output as text (`encodeOutput`: the
 * sandbox needs dd and base64). Piped bytes use native
 * stdin, chunk by chunk, followed by an explicit EOF; no input closes
 * stdin when the command starts. The SDK's own command timeout is off: a
 * command runs until mirage's limits stop it. A `mountType` serves the
 * workspace over a PTY, since E2B's exec decodes output as text.
 *
 * A sandbox you brought is yours: Mirage never kills it, and pauses it only
 * when the workspace pauses and its config says `onPause: 'pause'` or the
 * call names it. Once the SDK
 * says it is gone, connecting fails with how to replace it, and a line it
 * cut short loses its connection (129) with the same advice; the next line
 * connects again.
 */
export class E2BMachine extends MachineHandle<E2BConfig> implements PipeTransport {
  static override readonly configFields: ConfigFields = E2BConfig
  readonly [PIPE_TRANSPORT] = true as const
  static override readonly provider = 'e2b'
  protected override readonly pauses = true
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null
  // The sandbox the config names, which is the user's; null when Mirage starts one.
  private readonly brought: string | null
  // The sandbox this handle reaches: the config's, or the one Mirage started; null before that.
  private sandboxId: string | null
  // When Mirage's last work here ended, in ms since the epoch; null while it has work or had none.
  private idleAt: number | null = null
  // Pushes the busy timeout out again while Mirage's work here lasts.
  private refresher: ReturnType<typeof setInterval> | null = null
  // The timeout, in seconds, still to send E2B, and the sending under way.
  private wanted: number | null = null
  private pushing: Promise<void> | null = null
  // Whether the last timeout sent failed to arrive.
  private missed = false
  // Whether the sandbox Mirage started here is one the workspace failed to
  // remember and that could not be killed either: the next connect saves it.
  private unsaved = false
  // Whether work that came out of idle found its busy timeout missed: the
  // sandbox may have paused first, so the next connect reaches it anew.
  private asleep = false

  constructor(name: string, config?: E2BConfig) {
    super(name, config, E2BMachine.configFields)
    // Null is unset, as Python's None is: a YAML `sandbox_id: null` names no sandbox.
    this.brought = this.config.sandboxId ?? null
    if (this.brought !== null) requireId('e2b', 'sandboxId', this.brought)
    if ((this.config.template ?? null) !== null) requireId('e2b', 'template', this.config.template)
    const idle = this.config.idleTimeout ?? null
    if (idle !== null && !(typeof idle === 'number' && Number.isFinite(idle) && idle > 0))
      throw new Error(`e2b: idleTimeout must be a number of seconds above 0, got ${String(idle)}`)
    this.sandboxId = this.brought
    checkOnPause('e2b', this.config.onPause, ON_PAUSE)
  }

  /** The sandbox's id at E2B; its name before Mirage starts one. */
  override get instance(): string {
    return this.sandboxId ?? this.name
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<E2bSdk> {
    return loadOptionalPeer(() => import('e2b'), {
      feature: "the 'e2b' runtime",
      packageName: 'e2b',
    })
  }

  private async ensureSdk(): Promise<E2bSdk> {
    this.sdk ??= await this.loadSdk()
    return this.sdk
  }

  private apiParams(): Record<string, unknown> {
    return this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}
  }

  /**
   * Connect to the config's sandbox, or to the one Mirage started for this
   * workspace (resuming it when paused), or start one: from `template`, set
   * to pause itself on its timeout and stay paused until a connect resumes
   * it (a call that reaches it paused, such as the SDK's own health check,
   * leaves it paused), and remembered. A connect comes with work, so a
   * started one's timeout is `BUSY_TIMEOUT_SECONDS`. A started one that is
   * gone is forgotten and started anew; the config's fails with how to
   * replace it.
   */
  async connect(): Promise<void> {
    const sdk = await this.ensureSdk()
    if (this.brought === null && this.sandboxId === null) {
      this.sandboxId = (await this.memory?.recall(this.name)) ?? null
      this.startedHere = this.sandboxId !== null
    }
    if (this.sandboxId !== null) {
      try {
        this.sandbox = await sdk.Sandbox.connect(this.sandboxId, {
          ...this.apiParams(),
          ...(this.startedHere ? { timeoutMs: BUSY_TIMEOUT_SECONDS * 1000 } : {}),
        })
        if (this.unsaved) {
          await this.memory?.remember(this.name, this.sandboxId)
          this.unsaved = false
        }
        this.reached = true
        return
      } catch (error) {
        const hint = this.gone(sdk, error)
        if (hint === null) throw error
        if (!this.startedHere) throw new Error(hint, { cause: error })
        await this.memory?.forget(this.name)
        this.sandboxId = null
      }
    }
    this.sandbox = await sdk.Sandbox.create(this.config.template ?? DEFAULT_TEMPLATE, {
      ...this.apiParams(),
      timeoutMs: BUSY_TIMEOUT_SECONDS * 1000,
      lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { mirage_machine: this.name },
    })
    this.sandboxId = this.sandbox.sandboxId
    this.startedHere = true
    try {
      await this.memory?.remember(this.name, this.sandboxId)
    } catch (error) {
      await this.dropUnkept(sdk)
      throw error
    }
    this.reached = true
  }

  /**
   * Kill a sandbox just started that the workspace could not keep: no later
   * build would reach it, so it would outlive the workspace unseen. The next
   * connect starts another. One the kill misses stays this handle's, so the
   * next connect reaches it and saves it, and a delete removes it.
   */
  private async dropUnkept(sdk: E2bSdk): Promise<void> {
    const id = this.sandboxId
    this.sandbox = null
    if (id === null) return
    try {
      await sdk.Sandbox.kill(id, this.apiParams())
    } catch (error) {
      this.unsaved = true
      logger.debug?.(
        `${this.machine.toString()}: unkept sandbox ${id} not killed: ${String(error)}`,
      )
      return
    }
    this.sandboxId = null
    this.startedHere = false
  }

  /**
   * Keep a sandbox Mirage manages up while Mirage has work there: its E2B
   * timeout goes to `BUSY_TIMEOUT_SECONDS`, pushed out again every
   * `BUSY_REFRESH_SECONDS`. One whose idle timeout has passed has paused,
   * and gets its timeout as the work's connect resumes it (`stale`). Work
   * that comes while the idle timeout runs waits for the busy one to land,
   * or the sandbox could pause under it; when it misses, the sandbox may
   * have paused first, and the work's connect reaches it anew.
   */
  protected override async becameBusy(): Promise<void> {
    if (this.brought !== null) return
    if (!this.lapsed()) {
      const waking = this.idleAt !== null
      this.idleAt = null
      this.push(BUSY_TIMEOUT_SECONDS)
      if (waking && this.pushing !== null) {
        await this.pushing
        if (this.missed) this.asleep = true
      }
    }
    if (this.refresher === null) {
      this.refresher = setInterval(() => {
        this.push(BUSY_TIMEOUT_SECONDS)
      }, BUSY_REFRESH_SECONDS * 1000)
      ;(this.refresher as { unref?: () => void }).unref?.()
    }
  }

  /** Let a sandbox Mirage manages pause itself `idleTimeout` after its work ends. */
  protected override becameIdle(): void {
    if (this.brought !== null) return
    this.idleAt = Date.now()
    this.stopRefresher()
    this.push(this.idleSeconds())
  }

  /**
   * A sandbox Mirage manages whose idle timeout has passed has paused: the
   * next connect resumes it and reads its mounts anew.
   */
  protected override stale(): boolean {
    if (this.brought !== null || (!this.asleep && !this.lapsed())) return false
    this.asleep = false
    this.idleAt = null
    return true
  }

  /** Whether the idle timeout has passed since Mirage's last work ended. */
  private lapsed(): boolean {
    return (
      this.idleAt !== null &&
      Date.now() - this.idleAt >= (this.idleSeconds() - IDLE_MARGIN_SECONDS) * 1000
    )
  }

  /** Seconds the sandbox stays up once Mirage's work there ends. */
  private idleSeconds(): number {
    return this.config.idleTimeout ?? IDLE_TIMEOUT_SECONDS
  }

  private stopRefresher(): void {
    if (this.refresher === null) return
    clearInterval(this.refresher)
    this.refresher = null
  }

  /**
   * Set a started sandbox's E2B timeout to `seconds` from now, without
   * holding the work up. The timeouts go out one at a time, the newest
   * asked replacing any not yet sent; a sandbox not started yet gets its
   * timeout as it starts, and one that fails to arrive leaves the sandbox
   * on the timeout it had (`missed`).
   */
  private push(seconds: number): void {
    if (this.sandboxId === null || !this.startedHere) return
    this.wanted = seconds
    this.pushing ??= this.sendTimeouts()
  }

  private async sendTimeouts(): Promise<void> {
    // Yield first: `push` sets `pushing` to this before its end clears it.
    await Promise.resolve()
    try {
      while (this.wanted !== null) {
        const seconds = this.wanted
        this.wanted = null
        const id = this.sandboxId
        if (id === null || !this.startedHere) continue
        try {
          const sdk = await this.ensureSdk()
          await sdk.Sandbox.setTimeout(id, seconds * 1000, this.apiParams())
          this.missed = false
        } catch (error) {
          this.missed = true
          logger.debug?.(`${this.machine.toString()}: timeout not set: ${String(error)}`)
        }
      }
    } finally {
      this.pushing = null
    }
  }

  /**
   * Kill the sandbox Mirage started for this workspace, as the workspace is
   * deleted, and forget it; one the config names stays, with the mounts the
   * workspace left there released. Reaches the one the workspace remembers
   * when this build never connected.
   */
  override async destroy(): Promise<void> {
    if (this.brought !== null) {
      await this.releaseMounts()
      return
    }
    this.stopRefresher()
    const id = this.sandboxId ?? (await this.memory?.recall(this.name)) ?? null
    if (id === null) return
    const sdk = await this.ensureSdk()
    await sdk.Sandbox.kill(id, this.apiParams())
    await this.memory?.forget(this.name)
    this.sandboxId = null
    this.startedHere = false
  }

  /** Whether the config says `onPause: 'pause'`. */
  override configAsksToPause(): boolean {
    return this.config.onPause === 'pause'
  }

  /**
   * Pause the sandbox, keeping its disk and memory; the next connect resumes
   * it. A sandbox already gone has nothing to pause.
   */
  protected override async pauseMachine(): Promise<void> {
    this.stopRefresher()
    const id = this.sandboxId
    if (id === null) return
    const sdk = await this.ensureSdk()
    try {
      await sdk.Sandbox.pause(id, this.apiParams())
    } catch (error) {
      if (!(error instanceof sdk.SandboxNotFoundError)) throw error
      logger.debug?.(`${this.machine.toString()}: sandbox already gone, nothing to pause`)
    }
  }

  /** How to replace the sandbox when `error` says it is gone, else null. */
  private gone(sdk: E2bSdk, error: unknown): string | null {
    const state =
      error instanceof sdk.SandboxNotFoundError
        ? 'deleted'
        : error instanceof sdk.SandboxNotRunningError
          ? 'ended'
          : null
    return state === null ? null : notRunningHint('sandbox', this.instance, state, SANDBOX_GONE)
  }

  /**
   * The lost connection `error` is when it says the sandbox is gone, which
   * also lets the next line connect again; null otherwise.
   */
  private lost(sdk: E2bSdk, error: unknown): ConnectionLostError | null {
    const hint = this.gone(sdk, error)
    if (hint === null) return null
    this.disconnected()
    return new ConnectionLostError(hint)
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
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
    const handle = await this.sandbox.commands
      .run(encodeOutput(wrapLine(argv, env, cwd)), {
        background: true,
        stdin: stdin !== null,
        timeoutMs: 0,
        onStdout: decoding(output, out),
        onStderr: decoding(errors, err),
      })
      .catch(async (error: unknown) => {
        const lost = this.lost(sdk, error)
        if (lost !== null) await errors(ENC.encode(`e2b: ${lost.message}\n`))
        throw lost ?? error
      })
    let result: Pick<CommandResult, 'exitCode'>
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
      this.gone(sdk, error) === null &&
      ((error instanceof sdk.SandboxError &&
        CLOSED_INPUT.some((message) => error.message.includes(message))) ||
        // Process RPCs still throw this SDK class; no process-specific replacement exists.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        error instanceof sdk.NotFoundError)
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
      const lost = signal?.aborted === true ? null : this.lost(sdk, error)
      if (lost !== null) {
        await errors(ENC.encode(`e2b: ${lost.message}\n`))
        throw lost
      }
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
    if (outTail.byteLength > 0) await output(outTail)
    if (errTail.byteLength > 0) await errors(errTail)
    return { exitCode: result.exitCode }
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
    bounded = false,
  ): Promise<RunAnswer> {
    if (env[PROCESS] !== undefined) return super.execLine(line, stdin, env, cwd, signal, bounded)
    const tag = crypto.randomUUID().replaceAll('-', '')
    try {
      return await super.execLine(line, stdin, { ...env, [PROCESS]: tag }, cwd, signal, bounded)
    } catch (error) {
      if (signal?.aborted === true) await this.stop(tag, 15)
      throw error
    }
  }

  async openPipe(command: string): Promise<MachinePipe> {
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const sdk = await this.ensureSdk()
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
    const handle = await pty
      .create({ cols: 80, rows: 24, onData, timeoutMs: 0 })
      .catch((error: unknown) => {
        throw this.lost(sdk, error) ?? error
      })
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
      throw this.lost(sdk, err) ?? err
    }
    return { reader, writer, stop }
  }
}

registerMachine('e2b', E2BMachine)
