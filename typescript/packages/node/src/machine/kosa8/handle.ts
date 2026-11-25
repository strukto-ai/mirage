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

import { currentCaller } from '@struktoai/mirage-core/context/session_context'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import { closeQuietly } from '@struktoai/mirage-core/io/stream'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { checkOnPause, requireId } from '@struktoai/mirage-core/machine/config'
import {
  isRun,
  machineDirLine,
  notRunningHint,
  PROCESS,
  runTag,
  stopSignal,
} from '@struktoai/mirage-core/machine/constants'
import { ConnectionLostError } from '@struktoai/mirage-core/machine/errors'
import { MachineHandle, logger } from '@struktoai/mirage-core/machine/handle'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import type { OutputFn, RunAnswer, RunResult } from '@struktoai/mirage-core/runtime/types'
import { CANNOT_EXECUTE_STATUS } from '@struktoai/mirage-core/shell/constants'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import { Kosa8Api, Kosa8ApiError, Kosa8StreamCut } from './api.ts'
import { egressPolicy, Kosa8Config } from './config.ts'
import {
  EXEC_ARG_CHARS,
  EXEC_ARGS_MAX,
  IDLE_TIMEOUT_SECONDS,
  INPUT_LIMIT_BYTES,
  ON_PAUSE,
  PRELUDE,
  SANDBOX_GONE,
  STAGED_HEAD,
  START_POLL_SECONDS,
  START_WAIT_SECONDS,
} from './constants.ts'

const ENC = new TextEncoder()

/** A line's input ran past the machine's limit. */
export class InputTooLarge extends Error {
  constructor() {
    super('input too large')
    this.name = 'InputTooLarge'
  }
}

/** A word's length as kosa8 counts it, in UTF-16 code units. Mirrors Python's `js_length`. */
export function jsLength(word: string): number {
  return word.length
}

/** Whether kosa8 takes `words` as one exec's argv. */
export function fits(words: readonly string[]): boolean {
  return words.length <= EXEC_ARGS_MAX && words.every((word) => jsLength(word) <= EXEC_ARG_CHARS)
}

/**
 * `source`'s bytes, failing once they pass `limit`.
 *
 * Throws:
 *   InputTooLarge: the input is longer.
 */
export async function* capped(
  source: ByteSource,
  limit: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  let size = 0
  for await (const part of chunks(source, signal)) {
    size += part.byteLength
    if (size > limit) throw new InputTooLarge()
    yield part
  }
}

/**
 * A kosa8 sandbox, a microVM reached through kosa8 Cloud's API.
 *
 * Yours, by `sandboxId`, or, without one, a sandbox Mirage starts from
 * `template` or `image` at the first run that needs it and keeps in the
 * workspace's memory: a later build connects to it again, and one that is
 * gone is started anew. kosa8 puts a sandbox Mirage started to sleep once
 * nothing has run there for `idleTimeout`, Mirage puts it to sleep as the
 * workspace closes, and the next line wakes it; Mirage deletes it as the
 * workspace is deleted. `apiKey` falls back to KOSA8_API_KEY and `apiUrl`
 * to KOSA8_CLOUD_URL.
 *
 * Each line is one streamed exec. stdout and stderr come back apart, byte
 * for byte, as the program writes them. kosa8's exec takes no stdin, so a
 * line's input is uploaded to a file in Mirage's folder on the sandbox
 * first, which the program reads as its stdin; the program starts once its
 * input has ended, and input past `INPUT_LIMIT_BYTES` fails the line (126).
 * An argv past what one exec takes is staged as a script the same way.
 * kosa8 keeps a command running when its stream ends, so an aborted line is
 * stopped by its tag. It takes no `mountType`: put the files the programs
 * need on the sandbox.
 *
 * `network`, `allowedDomains` and `deniedDomains` set the sandbox's own
 * network policy, which kosa8 enforces inside the microVM: at boot for a
 * sandbox Mirage starts, at connect for one you brought.
 *
 * A sandbox you brought is yours: Mirage never deletes it, and puts it to
 * sleep only when the workspace pauses and its config says `onPause:
 * 'pause'` or the call names it. Once kosa8 says it is gone, connecting
 * fails with how to replace it, and a line it cut short loses its
 * connection (129) with the same advice; the next line connects again.
 */
export class Kosa8Machine extends MachineHandle<Kosa8Config> {
  static override readonly configFields: ConfigFields = Kosa8Config
  static override readonly provider = 'kosa8'
  protected override readonly pauses = true
  // The sandbox the config names, which is the user's; null when Mirage starts one.
  private readonly brought: string | null
  // The sandbox this handle reaches: the config's, or the one Mirage started; null before that.
  private sandboxId: string | null
  // The most input a line may be given (`INPUT_LIMIT_BYTES`).
  protected inputLimit: number = INPUT_LIMIT_BYTES
  private api: Kosa8Api | null = null
  // Mirage's folder on the sandbox, by the sandbox it is on.
  private folder: [string, string] | null = null

  constructor(name: string, config?: Kosa8Config) {
    super(name, config, Kosa8Machine.configFields)
    const c = this.config
    // Null is unset, as Python's None is: a YAML `sandbox_id: null` names no sandbox.
    this.brought = c.sandboxId ?? null
    if (this.brought !== null) {
      requireId('kosa8', 'sandboxId', this.brought)
      for (const [field, value] of [
        ['template', c.template],
        ['image', c.image],
        ['idleTimeout', c.idleTimeout],
        ['secrets', c.secrets],
      ] as const) {
        if ((value ?? null) !== null)
          throw new Error(
            `kosa8: ${field} applies to a sandbox Mirage starts; leave it out with a sandboxId`,
          )
      }
    }
    for (const [field, value] of [
      ['template', c.template],
      ['image', c.image],
    ] as const) {
      if ((value ?? null) !== null) requireId('kosa8', field, value)
    }
    if ((c.template ?? null) !== null && (c.image ?? null) !== null)
      throw new Error('kosa8: give a template or an image, not both')
    const idle = c.idleTimeout ?? null
    if (idle !== null && !(typeof idle === 'number' && Number.isFinite(idle) && idle >= 1))
      throw new Error(
        `kosa8: idleTimeout must be a number of seconds of at least 1, got ${String(idle)}`,
      )
    if ((c.network ?? null) !== null && typeof c.network !== 'boolean')
      throw new Error(`kosa8: network must be true or false, got ${String(c.network)}`)
    for (const field of ['allowedDomains', 'deniedDomains', 'secrets'] as const) {
      const value: unknown = c[field] ?? null
      if (value === null) continue
      if (
        !Array.isArray(value) ||
        !value.every((item: unknown) => typeof item === 'string' && item.trim() !== '')
      )
        throw new Error(`kosa8: ${field} must be a list of names`)
    }
    for (const entry of [...(c.allowedDomains ?? []), ...(c.deniedDomains ?? [])]) {
      if (entry.includes(':'))
        throw new Error(
          `kosa8: '${entry}': a sandbox's network names hosts, *.domain wildcards and IPv4 addresses or ranges, not ports or IPv6`,
        )
    }
    if (c.network === true && (c.allowedDomains ?? []).length > 0)
      throw new Error(
        'kosa8: network: true lets everything out; drop it to allow only allowedDomains',
      )
    if (c.network === false && (c.allowedDomains ?? []).length > 0)
      throw new Error('kosa8: network: false lets nothing out; drop it to allow allowedDomains')
    checkOnPause('kosa8', c.onPause, ON_PAUSE)
    this.sandboxId = this.brought
  }

  /** The sandbox's id at kosa8; its name before Mirage starts one. */
  override get instance(): string {
    return this.sandboxId ?? this.name
  }

  // The client factory as a seam: tests substitute a fake fetch here.
  protected newApi(): Kosa8Api {
    return new Kosa8Api(this.config.apiKey, this.config.apiUrl)
  }

  private client(): Kosa8Api {
    this.api ??= this.newApi()
    return this.api
  }

  /** The fields of the create that starts this machine's sandbox. */
  private createBody(): Record<string, unknown> {
    const c = this.config
    const body: Record<string, unknown> = {
      sleep_after_s: Math.ceil(c.idleTimeout ?? IDLE_TIMEOUT_SECONDS),
      labels: { mirage_machine: this.name },
    }
    if (c.template !== undefined) body.template = c.template
    if (c.image !== undefined) body.image = c.image
    const policy = egressPolicy(c)
    if (policy !== null) body.egress = policy
    if (c.secrets !== undefined && c.secrets.length > 0) body.secrets = [...c.secrets]
    return body
  }

  /**
   * Connect to the config's sandbox, setting its network policy when the
   * config has one, or to the one Mirage started for this workspace, or
   * start one and remember it. A started one that is gone is forgotten and
   * started anew; the config's fails with how to replace it. A sleeping
   * sandbox wakes on its next line.
   */
  async connect(): Promise<void> {
    const api = this.client()
    if (this.brought === null && this.sandboxId === null) {
      this.sandboxId = (await this.memory?.recall(this.name)) ?? null
      this.startedHere = this.sandboxId !== null
    }
    if (this.sandboxId !== null) {
      const state = await Kosa8Machine.state(api, this.sandboxId)
      if (SANDBOX_GONE[state] === undefined) {
        const policy = egressPolicy(this.config)
        if (this.brought !== null && policy !== null) await api.setEgress(this.sandboxId, policy)
        this.reached = true
        return
      }
      const hint = notRunningHint('sandbox', this.sandboxId, state, SANDBOX_GONE)
      if (!this.startedHere) throw new Error(hint)
      await this.memory?.forget(this.name)
      this.sandboxId = null
    }
    const sandbox = await api.create(this.createBody())
    this.sandboxId = String(sandbox.id)
    this.startedHere = true
    try {
      await this.memory?.remember(this.name, this.sandboxId)
      await this.untilRunning(api, sandbox)
    } catch (error) {
      await this.dropUnkept(api)
      throw error
    }
    this.reached = true
  }

  /** The sandbox's state at kosa8; `deleted` when it has none. */
  private static async state(api: Kosa8Api, sandboxId: string): Promise<string> {
    try {
      return String((await api.get(sandboxId)).state)
    } catch (error) {
      if (error instanceof Kosa8ApiError && error.status === 404) return 'deleted'
      throw error
    }
  }

  /**
   * Wait for a sandbox Mirage just started to run: one booted from an image
   * is still creating when the create answers.
   */
  private async untilRunning(api: Kosa8Api, sandbox: Record<string, unknown>): Promise<void> {
    const deadline = Date.now() + START_WAIT_SECONDS * 1000
    let state = String(sandbox.state)
    while (state === 'creating') {
      if (Date.now() > deadline)
        throw new Error(`kosa8: sandbox ${String(sandbox.id)} did not start in time`)
      await new Promise((resolve) => setTimeout(resolve, START_POLL_SECONDS * 1000))
      sandbox = await api.get(String(sandbox.id))
      state = String(sandbox.state)
    }
    if (SANDBOX_GONE[state] !== undefined) {
      const why =
        typeof sandbox.last_error === 'string' && sandbox.last_error !== ''
          ? sandbox.last_error
          : state
      throw new Error(`kosa8: sandbox ${String(sandbox.id)} did not start: ${why}`)
    }
  }

  /**
   * Delete a sandbox just started that the workspace could not keep or that
   * never ran, so it does not outlive the workspace unseen; the next
   * connect starts another.
   */
  private async dropUnkept(api: Kosa8Api): Promise<void> {
    const id = this.sandboxId
    this.sandboxId = null
    this.startedHere = false
    if (id === null) return
    try {
      await api.delete(id)
      await this.memory?.forget(this.name)
    } catch (error) {
      console.warn(
        `${String(this.machine)}: sandbox ${id} Mirage started could not be deleted`,
        error,
      )
    }
  }

  /**
   * Delete the sandbox Mirage started for this workspace, as the workspace is
   * deleted, and forget it; one the config names stays. Reaches the one the
   * workspace remembers when this build never connected.
   */
  override async destroy(): Promise<void> {
    if (this.brought !== null) {
      await this.releaseMounts()
      return
    }
    const id = this.sandboxId ?? (await this.memory?.recall(this.name)) ?? null
    if (id === null) return
    try {
      await this.newApi().delete(id)
    } catch (error) {
      if (!(error instanceof Kosa8ApiError) || error.status !== 404) throw error
    }
    await this.memory?.forget(this.name)
    this.sandboxId = null
    this.startedHere = false
  }

  /** Whether the config says `onPause: 'pause'`. */
  override configAsksToPause(): boolean {
    return this.config.onPause === 'pause'
  }

  /**
   * Put the sandbox to sleep, its memory and disk kept, through a client of
   * its own: close released the workspace's. The next line wakes it. One
   * already gone or asleep has nothing to do.
   */
  protected override async pauseMachine(): Promise<void> {
    if (this.sandboxId === null) return
    try {
      await this.newApi().sleep(this.sandboxId)
    } catch (error) {
      if (!(error instanceof Kosa8ApiError) || (error.status !== 404 && error.status !== 409))
        throw error
      logger.debug?.(`${String(this.machine)}: sandbox not running, nothing to put to sleep`)
    }
  }

  /**
   * The lost connection `error` is when the sandbox went or kosa8 could not
   * be reached, which also lets the next line connect again; null otherwise.
   * Its message is the hint the line says.
   */
  private lost(error: unknown): ConnectionLostError | null {
    let hint: string
    if (error instanceof Kosa8ApiError && (error.status === 404 || error.status === 409))
      hint = notRunningHint(
        'sandbox',
        this.instance,
        error.status === 404 ? 'deleted' : 'stopped',
        SANDBOX_GONE,
      )
    else if (error instanceof Kosa8ApiError && (error.status === 502 || error.status === 503))
      hint = error.message
    else if (error instanceof Kosa8StreamCut || error instanceof TypeError)
      hint = `kosa8 could not be reached: ${error.message}`
    else return null
    this.disconnected()
    return new ConnectionLostError(hint)
  }

  /** Mirage's own folder on the sandbox (`machineDirLine`), made if need be and asked once per sandbox. */
  private async machineFolder(
    api: Kosa8Api,
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.folder !== null && this.folder[0] === sandboxId) return this.folder[1]
    const line = machineDirLine([]) + 'printf %s "$d"'
    const out: Uint8Array[] = []
    const err: Uint8Array[] = []
    const dec = new TextDecoder()
    for await (const frame of api.exec(sandboxId, ['/bin/sh', '-c', line], [], signal)) {
      if (frame.data !== undefined) (frame.stream === 'stderr' ? err : out).push(frame.data)
      if (frame.exitCode !== undefined && frame.exitCode !== 0)
        throw new Error(
          err
            .map((part) => dec.decode(part, { stream: true }))
            .join('')
            .trim(),
        )
    }
    this.folder = [sandboxId, out.map((part) => dec.decode(part, { stream: true })).join('')]
    return this.folder[1]
  }

  /** Upload `data` to a new file in Mirage's folder on the sandbox and return its path. */
  private async stage(
    api: Kosa8Api,
    sandboxId: string,
    kind: string,
    data: ByteSource,
    signal?: AbortSignal,
  ): Promise<string> {
    const folder = await this.machineFolder(api, sandboxId, signal)
    const path = `${folder}/${kind}-${crypto.randomUUID().replaceAll('-', '')}`
    try {
      await api.upload(sandboxId, path, capped(data, this.inputLimit, signal))
    } catch (error) {
      await this.unstage(api, sandboxId, [path])
      throw error
    }
    return path
  }

  /** Remove staged files a line that never started left behind. */
  private async unstage(api: Kosa8Api, sandboxId: string, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      try {
        await api.remove(sandboxId, path)
      } catch (error) {
        logger.debug?.(`${String(this.machine)}: staged ${path} not removed: ${String(error)}`)
      }
    }
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
    const api = this.client()
    const sandboxId = this.sandboxId
    if (sandboxId === null) throw new Error('kosa8 machine not connected')
    const runner = currentCaller().process
    const staged: string[] = []
    let started = false
    let exitCode = -1
    try {
      let source = ''
      if (stdin !== null && !(stdin instanceof Uint8Array && stdin.byteLength === 0)) {
        source = await this.stage(api, sandboxId, 'in', stdin, signal)
        staged.push(source)
      }
      let words: readonly string[] = [
        '/bin/sh',
        '-c',
        PRELUDE,
        'sh',
        source,
        cwd,
        'env',
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        ...argv,
      ]
      if (!fits(words)) {
        const script = STAGED_HEAD + words.map(singleQuote).join(' ')
        const path = await this.stage(api, sandboxId, 'run', ENC.encode(script), signal)
        staged.push(path)
        words = ['/bin/sh', path]
      }
      for await (const frame of api.exec(sandboxId, words, [], signal)) {
        started = true
        if (frame.exitCode !== undefined) exitCode = frame.exitCode
        else if (frame.data !== undefined)
          await (frame.stream === 'stderr' ? errors : output)(frame.data)
      }
    } catch (error) {
      if (error instanceof InputTooLarge) {
        await errors(
          ENC.encode(
            `mirage: ${String(this.machine)}: input past ${String(this.inputLimit)} bytes; kosa8 takes a line's input whole\n`,
          ),
        )
        return { exitCode: CANNOT_EXECUTE_STATUS }
      }
      if (stdin !== null) void closeQuietly(stdin)
      if (!started && staged.length > 0) await this.unstage(api, sandboxId, staged)
      const lost = signal?.aborted === true ? null : this.lost(error)
      if (lost !== null) {
        await errors(ENC.encode(`kosa8: ${lost.message}\n`))
        throw lost
      }
      // kosa8 keeps the command once its stream ends: a run a kill stopped
      // with a gentler signal gets that signal first, and the caller stops
      // an abort.
      const tag = isRun(argv) ? runTag(argv) : env[PROCESS]
      const signum = stopSignal(runner)
      if (tag !== undefined && signum !== null) await this.stop(tag, signum)
      if (signal?.aborted === true) throw new DOMException('execute aborted', 'AbortError')
      if (tag !== undefined) await this.stop(tag, 15)
      throw error
    }
    return { exitCode }
  }

  /**
   * Execute one shell line, under a `PROCESS` tag of its own when the caller
   * gave none: kosa8 keeps a command its stream left, so an aborted line is
   * stopped by that tag.
   *
   * @param line the raw shell line.
   * @param stdin bytes piped into the line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param signal stops the line.
   * @param bounded hold what it keeps to the workspace's memory room.
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

  /** Release the API client once a connect under way has settled; the sandbox stays. */
  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      this.api = null
    }
  }
}

registerMachine('kosa8', Kosa8Machine)
