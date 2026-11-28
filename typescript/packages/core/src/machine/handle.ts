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
import {
  DEFAULT_UMASK,
  currentCaller,
  missingProgram,
  sessionUmask,
} from '../context/session_context.ts'
import { HANGUP_EXIT_CODE } from '../execution/job/constants.ts'
import type { MachineProcess } from '../execution/machine/types.ts'
import type { ProcessUsage } from '../execution/process/types.ts'
import { MachineName, type MachinePid, type MachineResources } from '../execution/types.ts'
import { PipeClosed } from '../io/errors.ts'
import { BytePipe } from '../io/pipe.ts'
import type { ByteSource } from '../io/types.ts'
import { answerOf, type WorkspaceBinding } from '../runtime/binding.ts'
import { coerceRuntimeConfig, type ConfigFields } from '../runtime/config.ts'
import type { MachineMemory, MountType, RunStatus, ScanFacts } from './types.ts'
import type { OutputFn, RunAnswer, RunResult } from '../runtime/types.ts'
import { CANNOT_EXECUTE_STATUS, NOT_FOUND_STATUS } from '../shell/constants.ts'
import { abortable, mergeSignals, settledWithin } from '../utils/abort.ts'
import { concat, findBytes, startsWith } from '../utils/bytes.ts'
import { boundSystemClock } from '../utils/clock.ts'
import { shellQuote } from '../utils/quote.ts'
import { rstripSlash } from '../utils/slash.ts'
import { MachineConfig, checkMountType, readAheadBytes } from './config.ts'
import {
  CHECK_LINE,
  CHECK_MARK,
  CHECK_WAIT_SECONDS,
  EXIT_DIGITS,
  FAKETIME_PROBE_SECONDS,
  MACHINE_STOP_WAIT_SECONDS,
  NOT_RUNNING_STATUS,
  PIPE_SIGNAL,
  RESOURCE_WAIT_SECONDS,
  RUN_DRAIN_SECONDS,
  RUN_PID_HOLD,
  RUN_PID_MARK,
  SCAN_FACTS_MARK,
  SCAN_MARK,
  SCAN_WAIT_SECONDS,
  STOP_POLL_SECONDS,
  faketimeEnv,
  faketimeProbe,
  machineResourcesLine,
  runArgv,
  runDoneMark,
  runExitMark,
  scanLine,
  signalLine,
  stopLine,
} from './constants.ts'
import { parseMachineResources } from './resources.ts'
import { ConnectionLostError } from './errors.ts'
import { isPipeTransport } from './mixin.ts'
import { MachineMounts } from './mounts.ts'

export const logger: { debug?: (message: string) => void } = {}

/**
 * One stream of a run with the pid line its wrapper writes ahead of the
 * program (`RUN_PID_MARK`) taken out, and the pid and start the line gives
 * handed to `found`. stderr may carry the exec client's own words ahead of
 * the line, so there (`search`) it is looked for within `RUN_PID_HOLD`
 * bytes, which wait until it shows; stdout carries it only where the exec
 * returns the two streams joined, at its very start, so there only what can
 * still begin it waits. Once it is out, or can no longer come, everything
 * passes as it arrives.
 * Mirrors Python's `PidLineFilter`.
 */
export class PidLineFilter {
  private held = new Uint8Array()
  private passing = false

  constructor(
    private readonly sink: OutputFn,
    private readonly found: (report: RunStatus) => void,
    private readonly search: boolean,
  ) {}

  /** Pass on what can no longer be, or hold, the pid line. */
  readonly write = async (data: Uint8Array): Promise<void> => {
    let out = data
    if (!this.passing) {
      this.held = concat([this.held, data])
      out = this.take()
    }
    if (out.byteLength > 0) await this.sink(out)
  }

  /** Pass on what is still held once the stream has ended. */
  async finish(): Promise<void> {
    const held = this.held
    this.held = new Uint8Array()
    this.passing = true
    if (held.byteLength > 0) await this.sink(held)
  }

  /**
   * What is held, less the pid line, once the line is out or can no longer
   * come; nothing while it still may.
   */
  private take(): Uint8Array {
    let held = this.held
    const at = this.search ? findBytes(held, RUN_PID_MARK) : startsWith(held, RUN_PID_MARK) ? 0 : -1
    const end = at >= 0 ? held.indexOf(0x0a, at) : -1
    if (end >= 0) {
      const text = new TextDecoder().decode(held.subarray(at + RUN_PID_MARK.byteLength, end))
      const report = parsePid(text)
      if (report !== null) this.found(report)
      held = concat([held.subarray(0, at), held.subarray(end + 1)])
    } else if (
      held.byteLength < RUN_PID_HOLD &&
      (at >= 0 || this.search || startsWith(RUN_PID_MARK, held))
    ) {
      return new Uint8Array()
    }
    this.held = new Uint8Array()
    this.passing = true
    return held
  }
}

/**
 * One stream of a run with the exit line its wrapper writes once the program
 * has exited (`runExitMark`) taken out, and the status the line gives
 * handed to `ended`. Only an ending that can still become the line is held;
 * everything else passes as it arrives, what the program left running
 * included. The status is told once the bytes written with the line have
 * been passed on, so a reader slow to take the program's last output (a
 * transport that answers whole, the line inside it) never has the run let
 * go while that output is still on its way. Mirrors Python's
 * `ExitLineFilter`.
 */
export class ExitLineFilter {
  private held = new Uint8Array()
  private passing = false
  private status: number | null = null

  /**
   * @param sink receives the stream without the line.
   * @param ended told the program's exit status.
   * @param mark what the run's exit line starts with.
   */
  constructor(
    private readonly sink: OutputFn,
    private readonly ended: (code: number) => void,
    private readonly mark: Uint8Array,
  ) {}

  /** Pass on what can no longer be, or hold, the exit line. */
  readonly write = async (data: Uint8Array): Promise<void> => {
    let out = data
    if (!this.passing) {
      const held = concat([this.held, data])
      this.held = new Uint8Array()
      out = this.take(held)
    }
    try {
      if (out.byteLength > 0) await this.sink(out)
    } finally {
      const status = this.status
      this.status = null
      if (status !== null) this.ended(status)
    }
  }

  /** Pass on what is still held once the stream has ended. */
  async finish(): Promise<void> {
    const held = this.held
    this.held = new Uint8Array()
    this.passing = true
    if (held.byteLength > 0) await this.sink(held)
  }

  /**
   * What is held, less the exit line once it is out, and less an ending that
   * may still become it, which stays held.
   */
  private take(held: Uint8Array): Uint8Array {
    const out: Uint8Array[] = []
    let rest = held
    for (let at = findBytes(rest, this.mark); at >= 0; at = findBytes(rest, this.mark)) {
      const tail = rest.subarray(at + this.mark.byteLength)
      const end = tail.findIndex((byte) => byte < 0x30 || byte > 0x39)
      const digits = end < 0 ? tail.byteLength : end
      if (digits > 0 && digits <= EXIT_DIGITS && tail[digits] === 0x0a) {
        this.passing = true
        this.status = Number(new TextDecoder().decode(tail.subarray(0, digits)))
        return concat([...out, rest.subarray(0, at), tail.subarray(digits + 1)])
      }
      if (digits === tail.byteLength && digits <= EXIT_DIGITS) {
        this.held = rest.slice(at)
        return concat([...out, rest.subarray(0, at)])
      }
      out.push(rest.subarray(0, at + 1))
      rest = rest.subarray(at + 1)
    }
    let keep = Math.min(rest.byteLength, this.mark.byteLength - 1)
    while (keep > 0 && !startsWith(this.mark, rest.subarray(rest.byteLength - keep))) keep -= 1
    this.held = rest.slice(rest.byteLength - keep)
    return concat([...out, rest.subarray(0, rest.byteLength - keep)])
  }
}

/**
 * How long a run's output has been quiet. A chunk still being handed to its
 * sink counts as moving until the sink takes it, so a reader slow to take what
 * the program wrote never makes the output quiet. Mirrors Python's
 * `OutputWatch`.
 */
export class OutputWatch {
  private busy = 0
  private moved = performance.now() / 1000

  /** `sink`, with each chunk handed to it counted as moving. */
  watched(sink: OutputFn): OutputFn {
    return async (data) => {
      this.busy += 1
      this.moved = performance.now() / 1000
      try {
        await sink(data)
      } finally {
        this.busy -= 1
        this.moved = performance.now() / 1000
      }
    }
  }

  /** Seconds since the output last moved; 0 while a chunk is still being handed on. */
  quiet(): number {
    return this.busy > 0 ? 0 : performance.now() / 1000 - this.moved
  }
}

/**
 * Whether a PATH names a folder by where the run stands: an entry that is
 * empty or not absolute, which a program lookup resolves against the working
 * folder. Mirrors Python's `_leans_on_folder`.
 *
 * @param path the PATH, null for the machine's own.
 */
function leansOnFolder(path: string | null): boolean {
  return path?.split(':').some((entry) => !entry.startsWith('/')) ?? false
}

/**
 * One machine a workspace runs programs on, reached through its provider:
 * the live connection, held once per workspace.
 *
 * You bring your own machine (a running container, a live Daytona or E2B
 * machine, an SSH host) and its config says how to reach it, or, for a
 * provider that can start one, the config says what to start and Mirage
 * starts it at the first run that needs it (`startedByMirage`): kept in the
 * workspace's memory (`bindMemory`) so a later build reaches the same one,
 * paused as the workspace closes and removed as it is deleted
 * (`destroy`). A machine you brought is never removed. The workspace reaches the machine
 * at the same prefixes as the host's, so the session cwd and every path in
 * a line resolve unchanged: a machine with a `mountType` is served them
 * (MachineMounts), otherwise serve them inside it yourself (`mirage
 * workspace create` in the image entrypoint or by hand). Subclasses adapt
 * one provider by implementing connect() and execArgv(), and PipeTransport
 * for a `mountType`; everything Mirage does there derives from execArgv: a
 * program's run (`run`), a stop by tag (`stop`), the libfaketime probe.
 * Constructed from the name the workspace gives it and its config, coerced
 * against the provider's own key list. Mirrors Python's `MachineHandle`.
 */
export abstract class MachineHandle<C extends MachineConfig = MachineConfig> {
  static readonly configFields: ConfigFields = MachineConfig
  /** The provider this class reaches machines through, as `machines:` spells it. */
  static readonly provider: string

  /** This handle's provider: its class's. */
  get provider(): string {
    return (this.constructor as typeof MachineHandle).provider
  }
  /** The provider config with the shared collection fields always present. */
  readonly config: C & Required<Pick<MachineConfig, 'env'>>
  // Connect-once latch: the first run connects; later runs just execute.
  // Single-flight so concurrent first runs share one connect, and a failed
  // connect clears the slot so the next run retries.
  protected connecting: Promise<void> | null = null
  // Whether `pauseMachine` pauses; only then does close wait for a connect under way, which an unbounded connect would otherwise hold.
  protected readonly pauses: boolean = false
  // Whether the machine's exec takes input. One that takes none (Daytona)
  // refuses a line given any before it runs, and a program that reads a
  // process substitution, which would need feeding.
  readonly takesInput: boolean = true
  // Whether the machine's exec hands stderr back joined into stdout
  // (Daytona), so a run's pid and exit lines arrive on its stdout.
  readonly joinsStreams: boolean = false
  // Set by a provider's connect that reached the machine; close hands it to `pausable` for the pause after.
  protected reached = false
  // Where the workspace keeps the machines Mirage started for it; null for a handle no workspace bound.
  protected memory: MachineMemory | null = null
  // Whether Mirage started the machine this handle reaches (or recalled one
  // it started) rather than the user bringing it: set by a provider that starts machines.
  protected startedHere = false
  private pausable = false
  private mounts: MachineMounts | null = null
  // The libfaketime the machine holds, asked once the first program runs
  // there under a system_time: null for none. Concurrent first runs share
  // the probe; a failed probe clears it so a later run asks again.
  private faketime: Promise<string | null> | null = null
  // The runs executing here right now; a scan asks only a machine with
  // one, or with processes an earlier scan found.
  private runs = 0
  // The work Mirage has under way here: programs' runs, its own lines and
  // stops, but not the pipe that serves the workspace (`busyWith`).
  private working = 0
  // The provider's `becameBusy` for the work under way: every piece of it
  // waits for that, not only the one that started it.
  private waking: Promise<void> | null = null
  // Whether the machine has a program, by name, asked once each.
  private readonly programs = new Map<string, Map<string, Promise<boolean>>>()

  /**
   * @param name the machine's name, its key under `machines:`.
   * @param config how to reach it.
   * @param configFields the keys the provider's config takes.
   */
  constructor(
    readonly name: string,
    config?: C,
    configFields: ConfigFields = MachineConfig,
  ) {
    const coerced = coerceRuntimeConfig(config, Object.keys(configFields), 'machine')
    this.config = { ...coerced, env: { ...coerced.env } }
    checkMountType(this.provider, coerced.mountType)
    readAheadBytes(this.provider, coerced.readAhead, 'readAhead')
    readAheadBytes(this.provider, coerced.readAheadTotal, 'readAheadTotal')
  }

  /** The machine's name with its provider, `<provider>:<name>`. */
  get machine(): MachineName {
    return new MachineName(this.provider, this.name)
  }

  /**
   * What the provider calls the machine: its container, sandbox, pod or
   * host there. Its name, for a provider that says nothing.
   */
  get instance(): string {
    return this.name
  }

  /**
   * Give the handle where its workspace keeps the machines Mirage started,
   * so a provider that starts one reaches the same machine on a later build.
   *
   * @param memory the workspace's memory of the machines it started.
   */
  bindMemory(memory: MachineMemory): void {
    this.memory = memory
  }

  /**
   * Whether Mirage started the machine this handle reaches, rather than the
   * user bringing it: its workspace pauses it as it closes and removes it as
   * it is deleted. False until a connect starts or recalls one.
   */
  get startedByMirage(): boolean {
    return this.startedHere
  }

  /**
   * Remove the machine Mirage started for this handle, as its workspace is
   * deleted, and forget it; one the user brought stays, with the mounts the
   * workspace left there released (`releaseMounts`). A provider that starts
   * machines overrides this.
   */
  destroy(): Promise<void> {
    return this.releaseMounts()
  }

  /**
   * Kill and unmount what the deleted workspace's earlier instances left
   * serving in the machine (`MachineMounts.release`), which nothing else
   * would take back. A connection opened for it is closed again. A failure
   * to connect or release is logged: the workspace is deleted either way.
   */
  protected async releaseMounts(): Promise<void> {
    if (this.mounts === null) this.serveMounts(this.config.mountType ?? null)
    if (this.mounts === null || this.memory === null) return
    const opened = this.connecting === null
    try {
      try {
        if (await this.reachToRelease()) await this.mounts.release(this.memory.workspaceId)
      } finally {
        if (opened && this.connecting !== null) await this.close()
      }
    } catch (error) {
      console.warn(
        `${String(this.machine)}: releasing the deleted workspace's mounts failed:`,
        error,
      )
    }
  }
  /**
   * Reach the machine for `releaseMounts`, as a line does; false when it
   * holds nothing to release. A provider whose connect starts a stopped
   * machine overrides this.
   */
  protected async reachToRelease(): Promise<boolean> {
    await this.ensureConnected()
    return true
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
    for (const lost of (await this.mounts?.sync()) ?? []) console.warn(lost)
  }

  /**
   * Connect once, validate the line, run it, then land what sshfs
   * acknowledged, failing the run with a landing that failed. The machine
   * has work from before it connects until the landing ends (`busyWith`).
   *
   * @param argv the program and its arguments.
   * @param ctx the run's stdin, environment, cwd and signal.
   * @param binding the workspace the run serves, whose mounts the machine
   *   is served.
   * @param output receives stdout as it arrives.
   * @param errors receives stderr as it arrives.
   */
  run(
    argv: readonly string[],
    ctx: Context,
    binding: WorkspaceBinding | null,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    return this.busyWith(() => this.runHere(argv, ctx, binding, output, errors))
  }

  /** `run`'s body, inside its work. */
  private async runHere(
    argv: readonly string[],
    ctx: Context,
    binding: WorkspaceBinding | null,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    // Served here rather than in the constructor, which runs before a
    // subclass names itself.
    if (this.mounts === null) this.serveMounts(this.config.mountType ?? null)
    await this.ensureConnected(ctx.signal)
    const refusal =
      (await this.mounts?.validate(binding, ctx.cwd.virtual, errors, ctx.signal)) ?? null
    if (refusal !== null) return refusal
    const [lead, reason, voice] = missingProgram(argv[0] ?? '')
    const missing: [string, string, string] = [`${lead}: `, reason, voice]
    const run = this.mounts?.guarded(argv, missing) ?? argv
    const given = { ...this.config.env, ...ctx.env }
    const clock = await this.systemTimeEnv(given, ctx.signal)
    // A deadline that passed during the probe starts nothing.
    ctx.signal?.throwIfAborted()
    // The run is the process it runs as, which its tag names; one run
    // outside a process gets a tag of its own.
    const runner = currentCaller().process
    const tag = runner?.record.id.toString() ?? crypto.randomUUID().replaceAll('-', '')
    const nonce = crypto.randomUUID().replaceAll('-', '')
    const mark = runExitMark(nonce)
    const letGo = new AbortController()
    let settle: (code: number) => void = () => undefined
    const ended = new Promise<number>((resolve) => {
      settle = resolve
    })
    this.runs += 1
    const reported: RunStatus[] = []
    const found = (report: RunStatus): void => {
      if (reported.length > 0) return
      reported.push(report)
      if (report.started !== null)
        runner?.setMachinePid({ pid: report.pid, started: report.started, exited: null })
    }
    const exited = (code: number): void => {
      settle(code)
    }
    let deliver: (code: number) => void = () => undefined
    const drained = new Promise<number>((resolve) => {
      deliver = resolve
    })
    const pidLine = new PidLineFilter(errors, found, true)
    const exitLine = new ExitLineFilter(pidLine.write, exited, mark)
    const doneLine = new ExitLineFilter(output, deliver, runDoneMark(nonce))
    let filters: (ExitLineFilter | PidLineFilter)[] = [exitLine, pidLine, doneLine]
    let sink = doneLine.write
    if (this.joinsStreams) {
      const outPid = new PidLineFilter(doneLine.write, found, false)
      const outExit = new ExitLineFilter(outPid.write, exited, mark)
      filters = [outExit, outPid, ...filters]
      sink = outExit.write
    }
    const watch = new OutputWatch()
    const mask = sessionUmask()
    const execution = this.execArgv(
      runArgv(
        tag,
        nonce,
        run,
        missing,
        currentCaller().joinsErrors,
        mask === DEFAULT_UMASK ? null : mask,
      ),
      ctx.stdin,
      { ...given, ...clock },
      ctx.cwd.virtual,
      watch.watched(sink),
      watch.watched(exitLine.write),
      mergeSignals(ctx.signal, letGo.signal),
    )
    let done: RunResult
    try {
      done = await this.outcome(execution, ended, drained, watch, letGo, ctx.signal)
      for (const filter of filters) await filter.finish()
    } catch (error) {
      if (ctx.signal?.aborted === true) {
        await this.stop(tag, runner?.signal ?? runner?.interrupted ?? 15, root(reported))
        throw error
      }
      if (error instanceof PipeClosed) {
        await this.stop(tag, PIPE_SIGNAL, root(reported))
        throw error
      }
      if (!(error instanceof ConnectionLostError)) throw error
      logger.debug?.(`${String(this.machine)}: connection lost: ${String(error)}`)
      runner?.programSignaled(HANGUP_EXIT_CODE - 128)
      for (const filter of filters) await filter.finish()
      await errors(new TextEncoder().encode(`mirage: ${String(this.machine)}: connection lost\n`))
      done = { exitCode: HANGUP_EXIT_CODE }
    } finally {
      this.runs -= 1
    }
    if (done.exitCode === NOT_FOUND_STATUS) this.forgetPrograms(argv)
    if (done.exitCode === CANNOT_EXECUTE_STATUS) this.mounts?.forget()
    // sshfs acknowledged the writes before they landed.
    const lost =
      this.mounts === null ? [] : await abortable(this.mounts.land(ctx.signal), ctx.signal)
    if (lost.length === 0) return done
    await errors(new TextEncoder().encode(lost.map((line) => `${line}\n`).join('')))
    return { exitCode: done.exitCode || 1 }
  }

  /**
   * How a run ended: its exec's answer, or, when its exit line says its
   * program has exited while the exec stays open because something the
   * program left running holds its output, the status the line gave. That
   * exec is kept until the line that ends the program's stdout has been handed
   * on (`drained`), so output a slow reader is still taking all arrives, then
   * let go after `RUN_DRAIN_SECONDS`, and what the program left running stays. A
   * stdout that never brings that line is waited on only until it has been
   * quiet that long. A run stopped meanwhile ends as stopped, whatever its
   * program said as it went, as Python's cancelled `_outcome` does. Mirrors
   * Python's `_outcome`.
   */
  private async outcome(
    execution: Promise<RunResult>,
    ended: Promise<number>,
    drained: Promise<number>,
    watch: OutputWatch,
    letGo: AbortController,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const closed = execution.then(
      () => null,
      () => null,
    )
    const code = await Promise.race([ended, closed])
    if (code === null) return execution
    const either = Promise.race([closed, drained])
    for (let quiet = watch.quiet(); quiet < RUN_DRAIN_SECONDS; quiet = watch.quiet()) {
      const wait = Math.max(RUN_DRAIN_SECONDS - quiet, STOP_POLL_SECONDS)
      if (await settledWithin(either, wait)) break
    }
    if (await settledWithin(closed, 0)) return execution
    const delivered = await settledWithin(drained, 0)
    if (delivered && (await settledWithin(execution, RUN_DRAIN_SECONDS))) return execution
    letGo.abort()
    await settledWithin(closed, RUN_DRAIN_SECONDS)
    signal?.throwIfAborted()
    return { exitCode: code }
  }

  /**
   * Reach the machine and run the check line (`CHECK_LINE`), within
   * `CHECK_WAIT_SECONDS`: true when Mirage can see and stop every process a
   * program here starts, false when only what it started itself; throws
   * when the machine could not be reached in time. Mirrors Python's
   * `MachineHandle.check`.
   */
  /**
   * What a line that needs input answers on a machine that takes none
   * (`takesInput`): 126, with why. Mirrors Python's `input_refused`.
   *
   * @param errors where why is said.
   */
  async inputRefused(errors: OutputFn): Promise<RunResult> {
    await errors(
      new TextEncoder().encode(`mirage: ${this.machine.toString()}: the machine takes no input\n`),
    )
    return { exitCode: CANNOT_EXECUTE_STATUS }
  }

  async check(): Promise<boolean> {
    const ran = await this.connectedLine(CHECK_LINE, CHECK_WAIT_SECONDS)
    if (!new TextDecoder().decode(ran.stdout).includes(CHECK_MARK))
      throw new Error(`${this.machine.toString()}: check did not run: exit ${String(ran.exitCode)}`)
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
   * @param roots each run's program on the machine, by its pid: its tag and
   *   start, which a Mac knows a run by.
   */
  async status(
    workspace: string,
    roots: ReadonlyMap<number, readonly [string, number]> = new Map(),
  ): Promise<MachineProcess[]> {
    const done = await this.connectedLine(scanLine(workspace, roots), SCAN_WAIT_SECONDS)
    if (done.exitCode !== 0)
      throw new Error(`${this.machine.toString()}: scan exited ${String(done.exitCode)}`)
    return parseScan(done.stdout)
  }

  /**
   * What the machine holds now (`machineResourcesLine`), within
   * `RESOURCE_WAIT_SECONDS`. Mirrors Python's `resources`.
   *
   * @param cpu read the processors' time and the process states too.
   */
  async resources(cpu: boolean): Promise<MachineResources> {
    const done = await this.connectedLine(machineResourcesLine(cpu), RESOURCE_WAIT_SECONDS)
    if (done.exitCode !== 0)
      throw new Error(`${this.machine.toString()}: read exited ${String(done.exitCode)}`)
    return parseMachineResources(new TextDecoder().decode(done.stdout), this.machine.toString())
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
        `${this.machine.toString()}: signal ${String(signum)} not sent: exit ${String(done.exitCode)}`,
      )
    return done.exitCode === 0
  }

  /**
   * Stop a run: every process its `PROCESS` tag marks gets `signum`, then
   * KILL a second later. Connecting and stopping take at most
   * `MACHINE_STOP_WAIT_SECONDS`, so a machine that stopped answering never
   * holds a cancel or an error. Answers true once the machine held the run's
   * processes and they were stopped, false when it holds none of them, could
   * not be reached, or the stop failed.
   *
   * @param tag the id of the process the run is, as `PROCESS` carries it.
   * @param signum the first signal.
   * @param root the run's program, as its wrapper reported it; null when it
   *   did not.
   */
  async stop(tag: string, signum: number, root: MachinePid | null = null): Promise<boolean> {
    const signal = AbortSignal.timeout(MACHINE_STOP_WAIT_SECONDS * 1000)
    try {
      await this.ensureConnected(signal)
      const done = await abortable(
        this.busyWith(() =>
          answerOf((output, errors) =>
            this.execArgv(
              ['/bin/sh', '-c', stopLine(tag, signum, root)],
              null,
              { ...this.config.env },
              '/',
              output,
              errors,
              signal,
            ),
          ),
        ),
        signal,
      )
      if (done.exitCode !== 0 && done.exitCode !== NOT_RUNNING_STATUS) {
        console.debug(
          `${this.machine.toString()}: run ${tag} not stopped: exit ${String(done.exitCode)}`,
        )
      }
      return done.exitCode === 0
    } catch (error) {
      console.debug(`${this.machine.toString()}: run ${tag} not stopped: ${String(error)}`)
      return false
    }
  }

  /** Let the machine see the workspace by `mountType`; null serves nothing. */
  private serveMounts(mountType: MountType | null): void {
    if (mountType === null) return
    if (!isPipeTransport(this))
      throw new Error(`${this.provider}: mountType needs a pipe transport`)
    this.mounts = new MachineMounts(
      this.provider,
      this.name,
      mountType,
      this.setup.bind(this),
      this.openPipe.bind(this),
      () => this.working > 0,
      readAheadBytes(this.provider, this.config.readAhead, 'readAhead'),
      readAheadBytes(this.provider, this.config.readAheadTotal, 'readAheadTotal'),
    )
  }

  /** Run one of Mirage's own lines on the machine: its environment, at `/`. */
  private setup(line: string, signal?: AbortSignal): Promise<RunAnswer> {
    return this.execLine(line, null, { ...this.config.env }, '/', signal)
  }

  /** Connect, then run one of Mirage's own lines, within `seconds` in all. */
  private async connectedLine(line: string, seconds: number): Promise<RunAnswer> {
    const deadline = AbortSignal.timeout(seconds * 1000)
    await this.ensureConnected(deadline)
    return abortable(this.setup(line, deadline), deadline)
  }

  /**
   * Let the next run connect again, and read the machine's mounts again
   * then: a connection that went may have taken them with it.
   */
  protected disconnected(): void {
    this.connecting = null
    this.mounts?.forget()
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
      probe = abortable(this.setup(faketimeProbe(), deadline), deadline).then((found) => {
        if (found.exitCode !== 0)
          throw new Error(
            `${this.machine.toString()}: libfaketime probe exited ${String(found.exitCode)}`,
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

  /**
   * Connect once; after a disconnect, or once the provider says the
   * connection went stale (`stale`), the next call connects again.
   */
  async ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.stale()) this.disconnected()
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
   * @param output receives stdout as it arrives; a transport that gets it
   *   whole writes it once.
   * @param errors the same for stderr.
   * @param signal stops the program.
   */
  protected abstract execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult>

  /**
   * Execute one of Mirage's own shell lines on the machine, as `/bin/sh
   * -c`, and keep its answer whole for the caller.
   *
   * @param line the raw shell line.
   * @param stdin bytes piped into the line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param signal stops the line.
   * @param bounded hold what it keeps to the workspace's memory room, for a
   *   line that reads a file's content.
   */
  execLine(
    line: string,
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
    bounded = false,
  ): Promise<RunAnswer> {
    return this.busyWith(() =>
      answerOf(
        (output, errors) =>
          this.execArgv(['/bin/sh', '-c', line], stdin, env, cwd, output, errors, signal),
        bounded,
      ),
    )
  }

  /**
   * Execute one of Mirage's own shell lines on the machine, as `/bin/sh
   * -c`, and hand its output over as it is read, never held whole: a reader
   * that falls behind holds the line back, and one that stops early stops
   * it. A line that fails, by its status or by what it says on stderr,
   * throws `failed`'s error once the output before it has been read.
   *
   * @param line the raw shell line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param failed the error of a line that ended with this status and
   *   stderr.
   * @param signal stops the line, a read waiting on it included.
   */
  async *streamLine(
    line: string,
    env: Record<string, string>,
    cwd: string,
    failed: (status: number, err: Uint8Array) => Error,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const pipe = new BytePipe()
    const said: Uint8Array[] = []
    const stop = new AbortController()
    const cancel = (): void => {
      stop.abort(signal?.reason)
    }
    if (signal?.aborted === true) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    const ran = this.busyWith(() =>
      this.execArgv(
        ['/bin/sh', '-c', line],
        null,
        env,
        cwd,
        (chunk) => pipe.write(chunk, stop.signal),
        (chunk) => {
          said.push(chunk)
          return Promise.resolve()
        },
        stop.signal,
      ),
    ).then(
      (done) => {
        const err = concat(said)
        pipe.end(done.exitCode !== 0 || err.byteLength > 0 ? failed(done.exitCode, err) : undefined)
      },
      (error: unknown) => {
        pipe.end(error)
      },
    )
    try {
      yield* pipe.stream()
    } finally {
      signal?.removeEventListener('abort', cancel)
      pipe.closeReader()
      stop.abort()
      await ran
    }
  }

  /**
   * Count `work` as Mirage's work on the machine while it runs: the first
   * piece to start tells the provider the machine is busy (`becameBusy`),
   * and the last to end that it is idle (`becameIdle`). Mirrors Python's
   * `MachineHandle._at_work`.
   *
   * @param work what runs on the machine.
   */
  private async busyWith<T>(work: () => Promise<T>): Promise<T> {
    this.working += 1
    try {
      if (this.working === 1) this.waking = this.becameBusy()
      await this.waking
      return await work()
    } finally {
      this.working -= 1
      if (this.working === 0) {
        this.waking = null
        this.becameIdle()
      }
    }
  }

  /**
   * Told as Mirage starts work on the machine while it had none: a
   * program's run, before it connects, or one of Mirage's own lines. A
   * provider whose machine pauses itself when idle keeps it up from here;
   * the work waits for it.
   */
  protected becameBusy(): Promise<void> {
    return Promise.resolve()
  }

  /** Told as the last of Mirage's work on the machine ends. */
  protected becameIdle(): void {
    return
  }

  /**
   * Whether the connection may have gone since the last work, so the next
   * connect reaches the machine anew: a machine that paused itself once
   * idle. Asked as each connect starts.
   */
  protected stale(): boolean {
    return false
  }

  /**
   * Whether the machine has a program of this name on its PATH, asked once.
   *
   * @param name the program's name.
   */
  hasProgram(name: string): Promise<boolean> {
    return this.programs.get(name)?.get(JSON.stringify([null, null])) ?? this.look(name, null, null)
  }

  /**
   * Whether a run started now would find a program of this name: on the PATH
   * the session exported, which the run gets, and asked again where the last
   * answer was no, since the program may have been installed since. A PATH
   * that names a folder by where the run stands (`venv/bin:/usr/bin`) is
   * looked on from the run's folder, and its answer is kept for that folder
   * alone.
   *
   * @param name the program's name.
   * @param path the PATH the session exported; null for the machine's own.
   * @param cwd the folder the run starts in.
   */
  async findsProgram(
    name: string,
    path: string | null = null,
    cwd: string | null = null,
  ): Promise<boolean> {
    const at = leansOnFolder(path) ? cwd : null
    const known = this.programs.get(name)?.get(JSON.stringify([path, at]))
    return (known !== undefined && (await known)) || this.look(name, path, at)
  }

  /**
   * Ask the machine for a program on a PATH, and keep the answer.
   *
   * @param name the program's name.
   * @param path the PATH to look on; null for the machine's own.
   * @param cwd the folder to look from; null for `/`. A machine without the
   *   folder has no such program.
   */
  private look(name: string, path: string | null, cwd: string | null): Promise<boolean> {
    const key = JSON.stringify([path, cwd])
    const at = cwd === null ? '' : `cd -- ${shellQuote(cwd)} 2>/dev/null && `
    const on = path === null ? '' : `PATH=${shellQuote(path)} `
    const found = this.ensureConnected()
      .then(() => this.setup(`${at}${on}command -v ${shellQuote(name)} >/dev/null 2>&1`))
      .then((done) => done.exitCode === 0)
    const kept = this.programs.get(name) ?? new Map<string, Promise<boolean>>()
    this.programs.set(name, kept)
    kept.set(key, found)
    found.catch(() => {
      if (kept.get(key) === found) kept.delete(key)
    })
    return found
  }

  /**
   * Drop what is kept of the programs a run names, once it ended with
   * `command not found`: one removed from the machine since it was last
   * asked is asked for again, so the next search leaves the machine out.
   *
   * @param words the run's words.
   */
  private forgetPrograms(words: readonly string[]): void {
    for (const word of words) this.programs.delete(word)
  }

  /**
   * Run a lookup the agent typed (`which perl`) as the machine answers it:
   * in the environment a program run there gets (`env` over the machine's
   * own), connecting first. It runs at `/`: the session's cwd is often a
   * mount the machine is served only for a run. Asked anew each time, so a
   * program installed since the last one is found.
   *
   * @param line the lookup's shell line.
   * @param env the session's exported variables.
   */
  async lookUp(line: string, env: Readonly<Record<string, string>>): Promise<RunAnswer> {
    await this.ensureConnected()
    return this.execLine(line, null, { ...this.config.env, ...env }, '/')
  }

  /**
   * Unmount what the machine was served; the machine itself is the user's.
   * The next run connects again, so a workspace that takes the handle after
   * this one reaches the machine anew. On a machine that pauses, a connect
   * still under way settles first, and what this workspace reached, cleanup
   * included, is handed to the pause after.
   */
  async close(): Promise<void> {
    if (this.pauses) await Promise.allSettled([this.connecting])
    try {
      await this.mounts?.close()
    } finally {
      this.pausable = this.reached
      this.reached = false
      this.disconnected()
    }
  }

  /**
   * Whether the machine's config asks to pause it when its workspace pauses
   * without naming the machines to pause.
   */
  configAsksToPause(): boolean {
    return false
  }

  /**
   * Pause the machine after its workspace closed to pause, when that
   * workspace reached it; by default the machine is only disconnected.
   */
  async pause(): Promise<void> {
    const pausable = this.pausable
    this.pausable = false
    if (pausable) await this.pauseMachine()
  }

  /**
   * Pause the machine a closed workspace reached. A provider that can pause
   * overrides this, and its next connect resumes the machine; a machine
   * already gone counts as paused.
   */
  protected pauseMachine(): Promise<void> {
    return Promise.resolve()
  }
}

/** What a run's pid line says (`RUN_WRAPPER`), null when it names no pid. */
function parsePid(text: string): RunStatus | null {
  const digits = /^[0-9]+$/
  const [pid = '', started = ''] = text.trim().split(/\s+/)
  if (!digits.test(pid)) return null
  return { pid: Number(pid), started: digits.test(started) ? Number(started) : null }
}

/** What `SCAN_FACTS_MARK`'s row says, null if it is not numbers. */
function parseFacts(text: string): ScanFacts | null {
  const fields = text.trim().split(/\s+/)
  if (fields.length !== 4 || fields.some((field) => !/^[0-9.]+$/.test(field))) {
    console.debug('scan facts unread:', text)
    return null
  }
  const [up, ticks, page, memory] = fields.map(Number) as [number, number, number, number]
  return { upSeconds: up, ticks, page, memory }
}

/**
 * A process's use of its machine, as `ps` works it out: CPU time over the
 * whole seconds it has run, and resident memory over the machine's, each in
 * truncated tenths of a percent. Mirrors Python's `_usage_of`.
 */
function usageOf(
  facts: ScanFacts | null,
  started: number,
  ticks: readonly string[],
): ProcessUsage | null {
  if (facts === null || !ticks.every((field) => /^[0-9]+$/.test(field))) return null
  const [user, system, vsize, pages] = ticks.map(Number) as [number, number, number, number]
  const cpuSeconds = (user + system) / facts.ticks
  const elapsed = Math.trunc(facts.upSeconds - started / facts.ticks)
  const rss = Math.floor((pages * facts.page) / 1024)
  return {
    cpuSeconds,
    cpuPercent: elapsed > 0 ? Math.min(Math.trunc((cpuSeconds * 1000) / elapsed), 9990) / 10 : 0,
    memoryPercent: facts.memory > 0 ? Math.trunc((rss * 1000) / facts.memory) / 10 : 0,
    rss,
    vsz: Math.floor(vsize / 1024),
  }
}

/**
 * The program a run's wrapper reported, which a Mac stops a run by; null
 * before it did. Mirrors Python's `_root`.
 */
function root(reported: readonly RunStatus[]): MachinePid | null {
  const report = reported[0]
  if (report?.started == null) return null
  return { pid: report.pid, started: report.started, exited: null }
}

/**
 * What a scan printed (`scanLine`): each process. A line without a mark, or
 * with a field that is not a number, is a message the provider mixed in.
 * Mirrors Python's `_parse_scan`.
 */
function parseScan(stdout: Uint8Array | null): MachineProcess[] {
  const found: MachineProcess[] = []
  const digits = /^[0-9]+$/
  let facts: ScanFacts | null = null
  for (const line of new TextDecoder().decode(stdout ?? new Uint8Array()).split('\n')) {
    if (line.startsWith(`${SCAN_FACTS_MARK} `)) {
      facts = parseFacts(line.slice(2))
      continue
    }
    const fields = line.split(' ')
    if (fields.length < 11 || fields[0] !== SCAN_MARK) continue
    const [, tag = '', pid = '', ppid = '', started = '', state = ''] = fields
    if (!digits.test(pid) || !digits.test(ppid) || !digits.test(started)) continue
    found.push({
      tag,
      pid: Number(pid),
      ppid: Number(ppid),
      started: Number(started),
      args: fields.slice(10).join(' ').trim(),
      state,
      usage: usageOf(facts, Number(started), fields.slice(6, 10)),
    })
  }
  return found
}
