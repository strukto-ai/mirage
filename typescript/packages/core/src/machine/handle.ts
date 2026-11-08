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

import type { Context } from '../commands/config.ts'
import { currentCaller } from '../context/session_context.ts'
import type { MachineProcess } from '../execution/machine/types.ts'
import { MachineId, type MachinePid } from '../execution/types.ts'
import type { ByteSource } from '../io/types.ts'
import type { WorkspaceBinding } from '../runtime/binding.ts'
import { coerceRuntimeConfig, type ConfigFields } from '../runtime/config.ts'
import type { MountType } from './types.ts'
import type { OutputFn, RunResult } from '../runtime/types.ts'
import { CANNOT_EXECUTE_STATUS } from '../shell/constants.ts'
import { abortable } from '../utils/abort.ts'
import { concat } from '../utils/bytes.ts'
import { boundSystemClock } from '../utils/clock.ts'
import { rstripSlash } from '../utils/slash.ts'
import {
  BASE_CONFIG_FIELDS,
  checkMountType,
  type MachineConfig,
  type NormalizedMachineConfig,
} from './config.ts'
import {
  CHECK_LINE,
  CHECK_MARK,
  CHECK_WAIT_SECONDS,
  FAKETIME_PROBE_SECONDS,
  faketimeEnv,
  faketimeProbe,
  PROCESS,
  NOT_RUNNING_STATUS,
  MACHINE_STOP_WAIT_SECONDS,
  stopLine,
  SCAN_MARK,
  SCAN_WAIT_SECONDS,
  scanLine,
  signalLine,
} from './constants.ts'
import { isPipeTransport } from './mixin.ts'
import { MachineMounts } from './mounts.ts'

/**
 * One machine a workspace runs programs on, reached through its provider:
 * the live connection, held once per workspace.
 *
 * Mirage never creates, provisions, or deletes a machine: you bring your
 * own (a running container, a live Daytona or E2B machine, an SSH host)
 * and its config says how to reach it. The workspace reaches the machine
 * at the same prefixes as the host's, so the session cwd and every path in
 * a line resolve unchanged: a machine with a `mountType` is served them
 * (MachineMounts), otherwise serve them inside it yourself (`mirage
 * workspace create` in the image entrypoint or by hand). Subclasses adapt
 * one provider by implementing connect() and execArgv(), and PipeTransport
 * for a `mountType`; everything Mirage does there derives from execArgv: a
 * program's run (`run`), a stop by tag (`reap`), the libfaketime probe.
 * Constructed from the name the workspace gives it and its config, coerced
 * against the provider's own key list. Mirrors Python's `MachineHandle`.
 */
export abstract class MachineHandle<C extends MachineConfig = MachineConfig> {
  static readonly configFields: ConfigFields = BASE_CONFIG_FIELDS
  /** The provider this class reaches machines through, as `machines:` spells it. */
  static readonly provider: string

  /** This handle's provider: its class's. */
  get provider(): string {
    return (this.constructor as typeof MachineHandle).provider
  }
  readonly config: NormalizedMachineConfig<C>
  // Connect-once latch: the first run connects; later runs just execute.
  // Single-flight so concurrent first runs share one connect, and a failed
  // connect clears the slot so the next run retries.
  private connecting: Promise<void> | null = null
  private mounts: MachineMounts | null = null
  // The libfaketime the machine holds, asked once the first program runs
  // there under a system_time: null for none. Concurrent first runs share
  // the probe; a failed probe clears it so a later run asks again.
  private faketime: Promise<string | null> | null = null
  // The runs executing here right now; a scan asks only a machine with
  // one, or with processes an earlier scan found.
  private runs = 0

  /**
   * @param name the machine's name, its key under `machines:`.
   * @param config how to reach it.
   * @param configFields the keys the provider's config takes.
   */
  constructor(
    readonly name: string,
    config?: C,
    configFields: ConfigFields = BASE_CONFIG_FIELDS,
  ) {
    const coerced = coerceRuntimeConfig(config, Object.keys(configFields), 'machine')
    this.config = { ...coerced, env: { ...coerced.env } }
    checkMountType(this.provider, coerced.mountType)
  }

  /** The machine's id, `<provider>:<name>`. */
  get id(): MachineId {
    return new MachineId(this.provider, this.name)
  }

  /**
   * Whether every file a program here writes goes through the workspace's
   * dispatch: the machine is served every prefix, so a write lands as the
   * session's own op.
   *
   * @param binding the workspace the runs serve.
   */
  fileEffectsDispatched(binding: WorkspaceBinding | null): boolean {
    return (
      this.mounts?.fileEffectsDispatched === true &&
      binding?.mountPrefixes != null &&
      !binding.mountPrefixes().includes('/')
    )
  }

  /**
   * Whether the machine is served the session's restricted view, so a run
   * there keeps its hides and modes.
   *
   * @param restrictedMounts the prefixes a rule restricts.
   */
  servesSession(restrictedMounts: readonly string[]): boolean {
    return (
      (this.mounts !== null || this.config.mountType != null) &&
      restrictedMounts.every((prefix) => !['', '/dev'].includes(rstripSlash(prefix)))
    )
  }

  /**
   * Land what a line's program left, however the line ended. Its exit
   * reported the landings that failed then; one that fails only here (the
   * deadline stopped the program or its exit's landing) is logged.
   */
  async settle(): Promise<void> {
    for (const lost of (await this.mounts?.finishLine()) ?? []) console.warn(lost)
  }

  /**
   * Connect once, bring the served mounts in step, run, then land what sshfs
   * acknowledged, failing the run with a landing that failed.
   *
   * @param argv the program and its arguments.
   * @param ctx the run's stdin, environment, cwd and signal.
   * @param binding the workspace the run serves, whose mounts the machine
   *   is served.
   * @param output receives stdout as it arrives.
   * @param errors receives stderr as it arrives.
   */
  async run(
    argv: readonly string[],
    ctx: Context,
    binding: WorkspaceBinding | null,
    output: OutputFn | null,
    errors: OutputFn | null,
  ): Promise<RunResult> {
    // Served here rather than in the constructor, which runs before a
    // subclass names itself.
    if (this.mounts === null) this.serveMounts(this.config.mountType ?? null)
    const unseen = this.mounts?.beginLine(binding, ctx.cwd.virtual) ?? null
    if (unseen !== null) return unseen
    await this.ensureConnected(ctx.signal)
    const refusal = (await this.mounts?.prepareLine(binding, ctx.signal)) ?? null
    if (refusal !== null) return refusal
    const run = this.mounts?.withMountGuard(argv) ?? argv
    const given = { ...this.config.env, ...ctx.env }
    const clock = await this.systemTimeEnv(given, ctx.signal)
    // A deadline that passed during the probe starts nothing.
    ctx.signal?.throwIfAborted()
    // The run is the process it runs as, which its tag names; one run
    // outside a process gets a tag of its own.
    const runner = currentCaller().process
    const tag = runner?.record.id.toString() ?? crypto.randomUUID().replaceAll('-', '')
    let done: RunResult
    this.runs += 1
    try {
      done = await this.execArgv(
        run,
        ctx.stdin,
        { ...given, ...clock, [PROCESS]: tag },
        ctx.cwd.virtual,
        output,
        errors,
        ctx.signal,
      )
    } catch (error) {
      if (ctx.signal?.aborted === true)
        await this.stopRunBounded(tag, runner?.signal ?? runner?.interrupted ?? 15)
      throw error
    } finally {
      this.runs -= 1
    }
    if (done.exitCode === CANNOT_EXECUTE_STATUS) this.mounts?.forgetMounts()
    // sshfs acknowledged the writes before they landed.
    const lost =
      this.mounts === null ? [] : await abortable(this.mounts.landWrites(ctx.signal), ctx.signal)
    if (lost.length === 0) return done
    const said = new TextEncoder().encode(lost.map((line) => `${line}\n`).join(''))
    return {
      stdout: done.stdout,
      stderr: concat([done.stderr ?? new Uint8Array(), said]),
      exitCode: done.exitCode || 1,
    }
  }

  /**
   * Reach the machine and run the check line (`CHECK_LINE`), within
   * `CHECK_WAIT_SECONDS`: true when Mirage can see and stop every process a
   * program here starts, false when only what it started itself; throws
   * when the machine could not be reached in time. Mirrors Python's
   * `MachineHandle.check`.
   */
  async check(): Promise<boolean> {
    const ran = await this.connectedLine(CHECK_LINE, CHECK_WAIT_SECONDS)
    if (!new TextDecoder().decode(ran.stdout).includes(CHECK_MARK))
      throw new Error(`${this.id.toString()}: check did not run: exit ${String(ran.exitCode)}`)
    return ran.exitCode === 0
  }

  /** Whether a run is executing on the machine right now. */
  get executing(): boolean {
    return this.runs > 0
  }

  /**
   * Every process the runs of `workspace` started on the machine, as one
   * scan (`scanLine`) finds them now, within `SCAN_WAIT_SECONDS`; throws
   * when the machine could not be reached or the scan failed. Mirrors
   * Python's `MachineHandle.status`.
   *
   * @param workspace the workspace's id.
   */
  async status(workspace: string): Promise<MachineProcess[]> {
    const done = await this.connectedLine(scanLine(workspace), SCAN_WAIT_SECONDS)
    if (done.exitCode !== 0)
      throw new Error(`${this.id.toString()}: scan exited ${String(done.exitCode)}`)
    return parseScanRows(done.stdout)
  }

  /**
   * Send `signum` to one process on the machine, as `kill` sent it
   * (`signalLine`): the program a run's tag names, or the process a machine
   * pid names while it is the one that started then. Connecting and sending
   * are bounded as a stop is (`MACHINE_STOP_WAIT_SECONDS`). Answers true once sent,
   * false when no such process runs there; throws when the machine could
   * not be reached or the line failed. Mirrors Python's
   * `MachineHandle.signal`.
   *
   * @param target the run's tag, or the process.
   * @param signum the signal.
   */
  async signal(target: string | MachinePid, signum: number): Promise<boolean> {
    const done = await this.connectedLine(signalLine(target, signum), MACHINE_STOP_WAIT_SECONDS)
    if (done.exitCode !== 0 && done.exitCode !== NOT_RUNNING_STATUS)
      throw new Error(
        `${this.id.toString()}: signal ${String(signum)} not sent: exit ${String(done.exitCode)}`,
      )
    return done.exitCode === 0
  }

  /**
   * Stop a run a lapsed workspace left on the machine: every process its
   * `PROCESS` tag marks gets `signum`, then KILL a second later. Connecting
   * is bounded as the stop is (`MACHINE_STOP_WAIT_SECONDS`). Answers true once the
   * machine held the run's processes and they were stopped, false when it
   * holds none of them, as a machine other than the run's does; throws when
   * the machine could not be reached or the stop failed.
   *
   * @param tag the id of the process the run is, as `PROCESS` carries it.
   * @param signum the first signal.
   */
  async stopRun(tag: string, signum: number): Promise<boolean> {
    await this.ensureConnected(AbortSignal.timeout(MACHINE_STOP_WAIT_SECONDS * 1000))
    const code = await this.stopRunBounded(tag, signum)
    if (code !== 0 && code !== NOT_RUNNING_STATUS)
      throw new Error(`${this.id.toString()}: run ${tag} not stopped`)
    return code === 0
  }

  /**
   * Stop what a cancelled or failed run left on the machine (`PROCESS`), for
   * at most `MACHINE_STOP_WAIT_SECONDS`: a machine that stopped answering would hold
   * the cancel or the error.
   *
   * @param tag the run's tag.
   * @param signum the signal the run is stopped with first.
   * @returns the stop line's status (`stopLine`); null when the machine did
   *   not answer.
   */
  protected async stopRunBounded(tag: string, signum: number): Promise<number | null> {
    const signal = AbortSignal.timeout(MACHINE_STOP_WAIT_SECONDS * 1000)
    try {
      const done = await abortable(
        this.execArgv(
          ['/bin/sh', '-c', stopLine(tag, signum)],
          null,
          { ...this.config.env },
          '/',
          null,
          null,
          signal,
        ),
        signal,
      )
      if (done.exitCode !== 0 && done.exitCode !== NOT_RUNNING_STATUS) {
        console.debug(
          `${this.id.toString()}: run ${tag} not stopped: exit ${String(done.exitCode)}`,
        )
      }
      return done.exitCode
    } catch (error) {
      console.debug(`${this.id.toString()}: run ${tag} not stopped: ${String(error)}`)
      return null
    }
  }

  /** Let the machine see the workspace by `mountType`; null serves nothing. */
  private serveMounts(mountType: MountType | null): void {
    if (mountType === null) return
    if (!isPipeTransport(this))
      throw new Error(`${this.provider}: mountType needs a pipe transport`)
    this.mounts = new MachineMounts(
      this.provider,
      mountType,
      this.controlLine.bind(this),
      this.openPipe.bind(this),
    )
  }

  /** Run one of Mirage's own lines on the machine: its environment, at `/`. */
  private controlLine(line: string, signal?: AbortSignal): Promise<RunResult> {
    return this.execLine(line, null, { ...this.config.env }, '/', signal)
  }

  /** Connect, then run one of Mirage's own lines, within `seconds` in all. */
  private async connectedLine(line: string, seconds: number): Promise<RunResult> {
    const deadline = AbortSignal.timeout(seconds * 1000)
    await this.ensureConnected(deadline)
    return abortable(this.controlLine(line, deadline), deadline)
  }

  protected disconnected(): void {
    this.connecting = null
  }

  /**
   * What a program on this machine needs to read the running workspace's
   * system time (`faketimeEnv`), through the libfaketime the machine holds.
   * Empty when the workspace keeps the host's time, and when the machine has
   * no libfaketime, where the program runs on the machine's clock. Mirrors
   * Python's `MachineHandle._system_time_env`.
   */
  private async systemTimeEnv(
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (boundSystemClock() === null) return {}
    let probe = this.faketime
    if (probe === null) {
      // Its own deadline, not the first caller's: every waiting run shares it.
      // It is also raced, as a provider may not stop a line on its signal.
      const deadline = AbortSignal.timeout(FAKETIME_PROBE_SECONDS * 1000)
      probe = abortable(this.controlLine(faketimeProbe(), deadline), deadline).then((found) => {
        if (found.exitCode !== 0)
          throw new Error(
            `${this.id.toString()}: libfaketime probe exited ${String(found.exitCode)}`,
          )
        return new TextDecoder().decode(found.stdout).trim() || null
      })
      this.faketime = probe
    }
    let library: string | null
    try {
      library = await abortable(probe, signal)
    } catch (err) {
      // This run's own deadline: the probe goes on for the others.
      if (signal?.aborted === true) throw err
      // Unanswered: this run keeps the machine's clock, and a later one asks again.
      if (this.faketime === probe) this.faketime = null
      return {}
    }
    return library === null ? {} : faketimeEnv(library, env)
  }

  protected async ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.connecting ??= this.connect().catch((err: unknown) => {
      this.connecting = null
      throw err
    })
    await abortable(this.connecting, signal)
    signal?.throwIfAborted()
  }

  /** Attach to the user's live machine, failing loud if absent. */
  abstract connect(): Promise<void>

  /**
   * Execute one argv on the machine: the provider's transport.
   *
   * @param argv the program and its arguments.
   * @param stdin the input, read as the program consumes it; null for none.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param output receives stdout as it arrives, which the result then
   *   leaves out; null, or a transport that cannot stream, returns it whole.
   * @param errors the same for stderr.
   * @param signal stops the program.
   */
  protected abstract execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult>

  /**
   * Execute one shell line on the machine, as `/bin/sh -c`.
   *
   * @param line the raw shell line.
   * @param stdin bytes piped into the line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param signal stops the line.
   */
  execLine(
    line: string,
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.execArgv(['/bin/sh', '-c', line], stdin, env, cwd, null, null, signal)
  }

  /**
   * Unmount what the machine was served; the machine itself is the user's.
   * The next run connects again, so a workspace that takes the handle after
   * this one reaches the machine anew.
   */
  async close(): Promise<void> {
    try {
      await this.mounts?.close()
    } finally {
      this.disconnected()
    }
  }
}

/**
 * The rows a scan printed (`scanLine`), each one a process; a line without
 * the mark, or with a field that is not a number, is a message the provider
 * mixed in.
 *
 * @param stdout what the scan printed.
 */
function parseScanRows(stdout: Uint8Array | null): MachineProcess[] {
  const found: MachineProcess[] = []
  const digits = /^[0-9]+$/
  for (const line of new TextDecoder().decode(stdout ?? new Uint8Array()).split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 6 || fields[0] !== SCAN_MARK) continue
    const [, tag = '', pid = '', ppid = '', started = ''] = fields
    if (!digits.test(pid) || !digits.test(ppid) || !digits.test(started)) continue
    found.push({
      tag,
      pid: Number(pid),
      ppid: Number(ppid),
      started: Number(started),
      args: fields.slice(5).join(' ').trim(),
    })
  }
  return found
}
