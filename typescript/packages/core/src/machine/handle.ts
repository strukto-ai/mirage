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
import { HANGUP_EXIT_CODE } from '../execution/job/constants.ts'
import type { MachineProcess } from '../execution/machine/types.ts'
import type { ProcessHandle } from '../execution/process/handle.ts'
import { MachineId, type MachinePid } from '../execution/types.ts'
import type { ByteSource } from '../io/types.ts'
import type { WorkspaceBinding } from '../runtime/binding.ts'
import { coerceRuntimeConfig, type ConfigFields } from '../runtime/config.ts'
import type { MountType, RunStatus } from './types.ts'
import type { OutputFn, RunResult } from '../runtime/types.ts'
import { CANNOT_EXECUTE_STATUS } from '../shell/constants.ts'
import { abortable, hasAborted, mergeSignals, settledWithin, sleep } from '../utils/abort.ts'
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
  RUN_DRAIN_SECONDS,
  RUN_START_WAIT_SECONDS,
  RUN_WATCH_SECONDS,
  SCAN_RUN_MARK,
  removeLine,
  runArgv,
  runStatusPath,
  statusLine,
  NOT_RUNNING_STATUS,
  MACHINE_STOP_WAIT_SECONDS,
  stopLine,
  SCAN_MARK,
  SCAN_WAIT_SECONDS,
  scanLine,
  signalLine,
} from './constants.ts'
import { ConnectionLostError } from './errors.ts'
import { isPipeTransport } from './mixin.ts'
import { MachineMounts } from './mounts.ts'

export const logger: { debug?: (message: string) => void } = {}

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
 * program's run (`run`), a stop by tag (`stop`), the libfaketime probe.
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
  // Each executing run's end and what finishes with it, by tag, for a look
  // at its report to settle while its exec stays open.
  private readonly ended = new Map<
    string,
    { settle: (code: number) => void; finished: Promise<unknown> }
  >()
  // The reports of runs that have ended, which the next run removes.
  private spent: string[] = []

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
    for (const lost of (await this.mounts?.sync()) ?? []) console.warn(lost)
  }

  /**
   * Connect once, validate the line, run it, then land what sshfs
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
    await this.ensureConnected(ctx.signal)
    const refusal = (await this.mounts?.validate(binding, ctx.cwd.virtual, ctx.signal)) ?? null
    if (refusal !== null) return refusal
    const run = this.mounts?.guarded(argv) ?? argv
    const given = { ...this.config.env, ...ctx.env }
    const clock = await this.systemTimeEnv(given, ctx.signal)
    // A deadline that passed during the probe starts nothing.
    ctx.signal?.throwIfAborted()
    // The run is the process it runs as, which its tag names; one run
    // outside a process gets a tag of its own.
    const runner = currentCaller().process
    const tag = runner?.record.id.toString() ?? crypto.randomUUID().replaceAll('-', '')
    const status = runStatusPath(tag)
    const spent = this.spent
    this.spent = []
    const kept: [Uint8Array[], Uint8Array[]] = [[], []]
    const letGo = new AbortController()
    let settle: (code: number) => void = () => undefined
    const ended = new Promise<number>((resolve) => {
      settle = resolve
    })
    let finished: () => void = () => undefined
    const left = new Promise<void>((resolve) => {
      finished = resolve
    })
    this.ended.set(tag, { settle, finished: runner?.join() ?? left })
    this.runs += 1
    const execution = this.execArgv(
      runArgv(tag, status, spent, run),
      ctx.stdin,
      { ...given, ...clock },
      ctx.cwd.virtual,
      output ?? ((data) => Promise.resolve(void kept[0].push(data))),
      errors ?? ((data) => Promise.resolve(void kept[1].push(data))),
      mergeSignals(ctx.signal, letGo.signal),
    )
    const background = runner?.background === true
    const watching = new AbortController()
    const watcher = background
      ? this.reportStart(runner, status, execution)
      : this.watch(status, settle, watching.signal)
    let done: RunResult
    try {
      done = await this.outcome(execution, ended, letGo)
      if (background) await watcher
    } catch (error) {
      if (ctx.signal?.aborted === true) {
        await this.stop(tag, runner?.signal ?? runner?.interrupted ?? 15)
        throw error
      }
      if (!(error instanceof ConnectionLostError)) throw error
      logger.debug?.(`${String(this.id)}: connection lost: ${String(error)}`)
      runner?.programSignaled(HANGUP_EXIT_CODE - 128)
      const said = new TextEncoder().encode(`mirage: ${String(this.id)}: connection lost\n`)
      done = {
        stdout: error.stdout,
        stderr: concat([error.stderr ?? new Uint8Array(), said]),
        exitCode: HANGUP_EXIT_CODE,
      }
    } finally {
      watching.abort()
      this.runs -= 1
      this.ended.delete(tag)
      this.spent.push(status)
      finished()
    }
    done = {
      stdout: done.stdout.byteLength > 0 ? done.stdout : concat(kept[0]),
      stderr:
        done.stderr !== null && done.stderr.byteLength > 0
          ? done.stderr
          : kept[1].length > 0
            ? concat(kept[1])
            : done.stderr,
      exitCode: done.exitCode,
    }
    if (done.exitCode === CANNOT_EXECUTE_STATUS) this.mounts?.forget()
    // sshfs acknowledged the writes before they landed.
    const lost =
      this.mounts === null ? [] : await abortable(this.mounts.land(ctx.signal), ctx.signal)
    if (lost.length === 0) return done
    const said = new TextEncoder().encode(lost.map((line) => `${line}\n`).join(''))
    return {
      stdout: done.stdout,
      stderr: concat([done.stderr ?? new Uint8Array(), said]),
      exitCode: done.exitCode || 1,
    }
  }

  /**
   * How a run ended: its exec's answer, or, when a look at its report found
   * its program gone while the exec stays open because something the program
   * left running holds its output, the status the report gave. That exec is
   * let go after a moment for the output still arriving, and what the
   * program left running stays. Mirrors Python's `_outcome`.
   */
  private async outcome(
    execution: Promise<RunResult>,
    ended: Promise<number>,
    letGo: AbortController,
  ): Promise<RunResult> {
    const closed = execution.then(
      () => null,
      () => null,
    )
    const code = await Promise.race([ended, closed])
    if (code === null) return execution
    if (await settledWithin(execution, RUN_DRAIN_SECONDS)) return execution
    letGo.abort()
    await settledWithin(closed, RUN_DRAIN_SECONDS)
    return { stdout: new Uint8Array(), stderr: null, exitCode: code }
  }

  /** One run's report as it stands, null when it wrote none. */
  private async readStatus(status: string): Promise<RunStatus | null> {
    const done = await this.connectedLine(statusLine(status), SCAN_WAIT_SECONDS)
    const lines = new TextDecoder().decode(done.stdout).split('\n')
    return parseStatus(lines[0] ?? '', lines[1] ?? '')
  }

  /**
   * Look for the end of a foreground run, which someone waits on, every
   * `RUN_WATCH_SECONDS`. A look that fails is tried again. Mirrors Python's
   * `_watch`.
   */
  private async watch(
    status: string,
    settle: (code: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await sleep(RUN_WATCH_SECONDS * 1000, signal)
        const found = await this.readStatus(status)
        if (found?.exitCode != null) {
          settle(found.exitCode)
          return
        }
      } catch (error) {
        if (!hasAborted(signal)) console.debug(`${this.id.toString()}: run not read:`, error)
      }
    }
  }

  /**
   * Give a background run's process its program's pid as soon as the program
   * has started, which `$!` waits for. One that ended at once still reported
   * it. Mirrors Python's `_report_start`.
   */
  private async reportStart(
    runner: ProcessHandle,
    status: string,
    execution: Promise<RunResult>,
  ): Promise<void> {
    const run = { ended: false }
    const finished = (): void => {
      run.ended = true
    }
    execution.then(finished, finished)
    let delay = 0.01
    for (let waited = 0; waited < RUN_START_WAIT_SECONDS;) {
      let found: RunStatus | null = null
      try {
        found = await this.readStatus(status)
      } catch (error) {
        console.debug(`${this.id.toString()}: run not read:`, error)
      }
      if (found?.pid != null) {
        if (found.started !== null)
          runner.setMachinePid({ pid: found.pid, started: found.started, exited: null })
        return
      }
      if (run.ended) return
      await sleep(delay * 1000)
      waited += delay
      delay = Math.min(delay * 2, 0.5)
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
    const [rows, reports] = parseScan(done.stdout, workspace)
    const finishing: Promise<unknown>[] = []
    for (const [tag, report] of reports) {
      const running = this.ended.get(tag)
      if (report.exitCode === null || running === undefined) continue
      running.settle(report.exitCode)
      finishing.push(running.finished)
    }
    // So whoever asked sees those runs as ended, not as about to.
    if (finishing.length > 0) await settledWithin(Promise.all(finishing), RUN_DRAIN_SECONDS + 1)
    return rows
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
   * Stop a run: every process its `PROCESS` tag marks gets `signum`, then
   * KILL a second later. Connecting and stopping take at most
   * `MACHINE_STOP_WAIT_SECONDS`, so a machine that stopped answering never
   * holds a cancel or an error. Answers true once the machine held the run's
   * processes and they were stopped, false when it holds none of them, could
   * not be reached, or the stop failed.
   *
   * @param tag the id of the process the run is, as `PROCESS` carries it.
   * @param signum the first signal.
   */
  async stop(tag: string, signum: number): Promise<boolean> {
    const signal = AbortSignal.timeout(MACHINE_STOP_WAIT_SECONDS * 1000)
    try {
      await this.ensureConnected(signal)
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
      return done.exitCode === 0
    } catch (error) {
      console.debug(`${this.id.toString()}: run ${tag} not stopped: ${String(error)}`)
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
      mountType,
      this.setup.bind(this),
      this.openPipe.bind(this),
    )
  }

  /** Run one of Mirage's own lines on the machine: its environment, at `/`. */
  private setup(line: string, signal?: AbortSignal): Promise<RunResult> {
    return this.execLine(line, null, { ...this.config.env }, '/', signal)
  }

  /** Connect, then run one of Mirage's own lines, within `seconds` in all. */
  /** Remove the reports no later run will, leaving them when the machine does not answer. */
  private async removeSpent(): Promise<void> {
    const spent = this.spent
    this.spent = []
    try {
      await this.connectedLine(removeLine(spent), MACHINE_STOP_WAIT_SECONDS)
    } catch (error) {
      console.debug(`${this.id.toString()}: reports not removed:`, error)
    }
  }

  private async connectedLine(line: string, seconds: number): Promise<RunResult> {
    const deadline = AbortSignal.timeout(seconds * 1000)
    await this.ensureConnected(deadline)
    return abortable(this.setup(line, deadline), deadline)
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
      probe = abortable(this.setup(faketimeProbe(), deadline), deadline).then((found) => {
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
      if (this.spent.length > 0) await this.removeSpent()
      await this.mounts?.close()
    } finally {
      this.disconnected()
    }
  }
}

/** A run's report from its two lines (`RUN_WRAPPER`), null when it wrote nothing yet. */
function parseStatus(first: string, second: string): RunStatus | null {
  const digits = /^[0-9]+$/
  const [pid = '', started = ''] = first.trim().split(/\s+/)
  if (!digits.test(pid)) return null
  const code = second.trim()
  return {
    pid: Number(pid),
    started: digits.test(started) ? Number(started) : null,
    exitCode: digits.test(code) ? Number(code) : null,
  }
}

/**
 * What a scan printed (`scanLine`): each process, knowing the program its
 * run reported, and each run's report by tag. A line without a mark, or with
 * a field that is not a number, is a message the provider mixed in. Mirrors
 * Python's `_parse_scan`.
 */
function parseScan(
  stdout: Uint8Array | null,
  workspace: string,
): [MachineProcess[], Map<string, RunStatus>] {
  const found: MachineProcess[] = []
  const reports = new Map<string, RunStatus>()
  const digits = /^[0-9]+$/
  for (const line of new TextDecoder().decode(stdout ?? new Uint8Array()).split('\n')) {
    if (line.startsWith(`${SCAN_RUN_MARK} `)) {
      const rest = line.slice(2)
      const space = rest.indexOf(' ')
      const number = rest.slice(0, space)
      const text = rest.slice(space + 1)
      const at = text.indexOf(';')
      const report = parseStatus(
        at < 0 ? text : text.slice(0, at),
        at < 0 ? '' : text.slice(at + 1),
      )
      if (space > 0 && digits.test(number) && report !== null)
        reports.set(`${workspace}:${number}`, report)
      continue
    }
    const fields = line.split(' ')
    if (fields.length < 7 || fields[0] !== SCAN_MARK) continue
    const [, tag = '', pid = '', ppid = '', started = '', state = ''] = fields
    if (!digits.test(pid) || !digits.test(ppid) || !digits.test(started)) continue
    found.push({
      tag,
      pid: Number(pid),
      ppid: Number(ppid),
      started: Number(started),
      args: fields.slice(6).join(' ').trim(),
      state,
    })
  }
  return [
    found.map((row) => {
      const report = reports.get(row.tag)
      return report === undefined ? row : { ...row, program: report.pid }
    }),
    reports,
  ]
}
