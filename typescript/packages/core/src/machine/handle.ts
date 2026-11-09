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
import { CANNOT_EXECUTE_STATUS, NOT_FOUND_STATUS, SIGTERM } from '../shell/constants.ts'
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
  JOB_END,
  JOB_END_PART,
  JOB_LOST,
  JOB_MARK,
  JOB_REFUSED_STATUS,
  JOB_REMOVE,
  JOB_START,
  JOB_VIEW,
  jobFolder,
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
  SETSID_PROBE,
  VIEW_RETRY_MAX_SECONDS,
  VIEW_RETRY_SECONDS,
} from './constants.ts'
import { ConnectionLostError, WritesHeldError } from './errors.ts'
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
  /**
   * Whether a background job's one program runs detached here, under a
   * wrapper in the box (`JOB_START`), so it outlives the connection; on only
   * for the providers it was measured on.
   */
  static readonly detaches: boolean = false

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
  // Whether the box holds setsid, asked once a job first detaches; a probe
  // that got no answer is cleared, so a later job asks again.
  private setsidProbe: Promise<boolean> | null = null
  // The folder of each detached job's run here, by its tag.
  private readonly detached = new Map<string, string>()
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
    const env = { ...given, ...clock }
    const detached = await this.detaches(runner, ctx)
    let done: RunResult | null = null
    this.runs += 1
    try {
      if (detached)
        done = await this.runDetached(
          run,
          env,
          ctx.cwd.virtual,
          tag,
          runner,
          output,
          errors,
          ctx.signal,
        )
      done ??= await this.runAttached(
        run,
        ctx.stdin,
        env,
        ctx.cwd.virtual,
        tag,
        runner,
        output,
        errors,
        ctx.signal,
      )
    } catch (error) {
      if (ctx.signal?.aborted === true) {
        if (runner?.released !== true) await this.stop(tag, stopWith(runner))
        throw error
      }
      if (!(error instanceof ConnectionLostError)) throw error
      done = this.connectionLost(runner, error)
    } finally {
      this.runs -= 1
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
   * Run a program over the connection, under the wrapper that reports it
   * (`runArgv`), to its end (`outcome`); an aborted run is left to `run` to
   * stop by its tag. Mirrors Python's `_run_attached`.
   */
  private async runAttached(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    tag: string,
    runner: ProcessHandle | null,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
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
    const execution = this.execArgv(
      runArgv(tag, status, spent, argv),
      stdin,
      env,
      cwd,
      output ?? ((data) => Promise.resolve(void kept[0].push(data))),
      errors ?? ((data) => Promise.resolve(void kept[1].push(data))),
      mergeSignals(signal, letGo.signal),
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
      if (signal?.aborted === true || !(error instanceof ConnectionLostError)) throw error
      done = this.connectionLost(runner, error)
    } finally {
      watching.abort()
      this.ended.delete(tag)
      this.spent.push(status)
      finished()
    }
    return {
      stdout: done.stdout.byteLength > 0 ? done.stdout : concat(kept[0]),
      stderr:
        done.stderr !== null && done.stderr.byteLength > 0
          ? done.stderr
          : kept[1].length > 0
            ? concat(kept[1])
            : done.stderr,
      exitCode: done.exitCode,
    }
  }

  /**
   * What a run whose connection went ends with: a hangup, with what it read
   * before. Mirrors Python's `_connection_lost`.
   */
  private connectionLost(runner: ProcessHandle | null, error: ConnectionLostError): RunResult {
    logger.debug?.(`${String(this.id)}: connection lost: ${String(error)}`)
    runner?.programSignaled(HANGUP_EXIT_CODE - 128)
    const said = new TextEncoder().encode(`mirage: ${String(this.id)}: connection lost\n`)
    return {
      stdout: error.stdout,
      stderr: concat([error.stderr ?? new Uint8Array(), said]),
      exitCode: HANGUP_EXIT_CODE,
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
    const group = typeof target === 'string' && this.detached.has(target)
    const done = await this.connectedLine(
      signalLine(target, signum, group),
      MACHINE_STOP_WAIT_SECONDS,
    )
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

  /**
   * Whether a run detaches: a detachable job's one program
   * (`ProcessHandle.detachable`), fed no input, on a machine that detaches,
   * holds setsid and is served no mounts, whose pipe would go with the
   * connection. Mirrors Python's `MachineHandle._detaches`.
   */
  private async detaches(runner: ProcessHandle | null, ctx: Context): Promise<boolean> {
    if (
      !(this.constructor as typeof MachineHandle).detaches ||
      runner?.detachable !== true ||
      ctx.stdin !== null ||
      this.mounts !== null
    )
      return false
    let probe = this.setsidProbe
    if (probe === null) {
      const deadline = AbortSignal.timeout(CHECK_WAIT_SECONDS * 1000)
      probe = abortable(this.setup(SETSID_PROBE, deadline), deadline).then((found) => {
        if (![0, 1, NOT_FOUND_STATUS].includes(found.exitCode))
          throw new Error(`${this.id.toString()}: setsid probe exited ${String(found.exitCode)}`)
        if (found.exitCode !== 0)
          logger.debug?.(`${this.id.toString()}: no setsid, so jobs stay attached`)
        return found.exitCode === 0
      })
      this.setsidProbe = probe
    }
    try {
      return await abortable(probe, ctx.signal)
    } catch (err) {
      if (ctx.signal?.aborted === true) throw err
      logger.debug?.(`${this.id.toString()}: setsid probe failed: ${String(err)}`)
      if (this.setsidProbe === probe) this.setsidProbe = null
      return false
    }
  }

  /**
   * Run a job's program detached (`JOB_START`), give its process the
   * program's pid once it started, and view it to its end (`view`), then
   * remove its folder; null when the box cannot detach it, for `run` to run
   * it attached. A start the connection dropped in is viewed all the same:
   * the job may run. A cancelled run removes its folder; `run` stops it by
   * its tag. Mirrors Python's `MachineHandle._run_detached`.
   */
  private async runDetached(
    argv: readonly string[],
    env: Record<string, string>,
    cwd: string,
    tag: string,
    runner: ProcessHandle | null,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult | null> {
    const folder = jobFolder(tag)
    if (runner !== null && !(await tellDetached(runner, this.id, folder))) return null
    this.detached.set(tag, folder)
    // Its program may run before the start returns: a lease lost meanwhile
    // releases it to the daemon that adopts it.
    if (runner !== null) runner.detached = true
    try {
      let started: RunResult | null = null
      try {
        started = await this.execArgv(
          ['/bin/sh', '-c', JOB_START, 'sh', folder, tag, ...argv],
          null,
          env,
          cwd,
          null,
          null,
          signal,
        )
      } catch (error) {
        if (!(error instanceof ConnectionLostError) || signal?.aborted === true) {
          // The wrapper may have started what nothing now views.
          if (signal?.aborted !== true) {
            if (runner !== null) runner.detached = false
            await this.stop(tag, SIGTERM)
            await this.removeJob(folder)
          }
          throw error
        }
        logger.debug?.(`${this.id.toString()}: job start lost: ${String(error)}`)
      }
      if (started?.exitCode === JOB_REFUSED_STATUS) {
        logger.debug?.(`${this.id.toString()}: job not detached: ${String(started.stderr)}`)
        this.detached.delete(tag)
        if (runner !== null) runner.detached = false
        await this.removeJob(folder)
        if (runner !== null) await untellDetached(runner, this.id)
        return null
      }
      if (started !== null && started.exitCode !== 0) {
        // A wrapper that outlived the start's wait may run it.
        if (runner !== null) runner.detached = false
        await this.stop(tag, SIGTERM)
        await this.removeJob(folder)
        return started
      }
      const program = parseStatus(new TextDecoder().decode(started?.stdout), '')
      if (runner !== null && program?.pid != null && program.started !== null)
        runner.setMachinePid({ pid: program.pid, started: program.started, exited: null })
      const done = await this.view(folder, tag, runner, output, errors, signal)
      await this.settled(runner, folder)
      return done
    } catch (error) {
      if (signal?.aborted === true && runner?.released !== true) await this.removeJob(folder)
      throw error
    } finally {
      this.detached.delete(tag)
    }
  }

  /**
   * View a detached job a daemon before this one started to its end, as
   * `run` would have, from the bytes its console already holds; stopped by
   * its tag once `signal` aborts, as `run` is. Mirrors Python's
   * `MachineHandle.resume`.
   *
   * @param folder the job's folder.
   * @param tag the id of the process its run was.
   * @param sent the stdout and stderr bytes already delivered.
   * @param output receives stdout as it arrives.
   * @param errors receives stderr as it arrives.
   * @param signal stops the program.
   */
  async resume(
    folder: string,
    tag: string,
    sent: readonly [number, number],
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const runner = currentCaller().process
    if (runner !== null) runner.detached = true
    this.detached.set(tag, folder)
    this.runs += 1
    let done: RunResult
    try {
      done = await this.view(folder, tag, runner, output, errors, signal, sent)
    } catch (error) {
      if (signal?.aborted === true && runner?.released !== true) {
        await this.stop(tag, stopWith(runner))
        await this.removeJob(folder)
      }
      throw error
    } finally {
      this.detached.delete(tag)
      this.runs -= 1
    }
    await this.settled(runner, folder)
    return done
  }

  /**
   * View a detached job to its end mark (`JOB_VIEW`), viewing again from the
   * bytes delivered whenever a viewer ends without it, however it ended,
   * after a wait that doubles while nothing new arrives. A job whose wrapper
   * is gone with no exit code ends hung up, its program stopped by its tag
   * should it still run. Output a transport returns
   * whole, or a callback that is null, is kept and returned. Mirrors
   * Python's `MachineHandle._view`.
   */
  private async view(
    folder: string,
    tag: string,
    runner: ProcessHandle | null,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
    from: readonly [number, number] = [0, 0],
  ): Promise<RunResult> {
    const sent = { out: from[0], err: from[1] }
    const kept: [Uint8Array[], Uint8Array[]] = [[], []]
    let wait = VIEW_RETRY_SECONDS
    for (;;) {
      const secret = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
      let held = new Uint8Array()
      const undelivered: unknown[] = []
      const out = async (data: Uint8Array): Promise<void> => {
        holdWrites(runner, undelivered)
        if (output === null) kept[0].push(data)
        else
          await output(data).catch((error: unknown) => {
            undelivered.push(error)
            throw error
          })
        sent.out += data.length
      }
      const err = async (data: Uint8Array): Promise<void> => {
        held = concat([held, data])
        const cut = unmarked(held)
        if (cut === 0) return
        const chunk = held.slice(0, cut)
        holdWrites(runner, undelivered)
        if (errors === null) kept[1].push(chunk)
        else
          await errors(chunk).catch(async (error: unknown) => {
            undelivered.push(error)
            await recountErrors(runner, sent, signal)
            throw error
          })
        held = held.slice(cut)
        sent.err += chunk.length
      }
      const before = sent.out + sent.err
      let returned: [Uint8Array | null, Uint8Array | null] = [null, null]
      let finished = false
      try {
        await this.ensureConnected(signal)
        const done = await this.execArgv(
          ['/bin/sh', '-c', JOB_VIEW, 'sh', folder, String(sent.out), String(sent.err), secret],
          null,
          { ...this.config.env },
          '/',
          out,
          err,
          signal,
        )
        returned = [done.stdout, done.stderr]
        finished = true
      } catch (error) {
        if (signal?.aborted === true) throw error
        logger.debug?.(`${this.id.toString()}: job view ended: ${String(error)}`)
        if (error instanceof ConnectionLostError) returned = [error.stdout, error.stderr]
      }
      try {
        if (returned[0] !== null && returned[0].length > 0) await out(returned[0])
        if (returned[1] !== null && returned[1].length > 0) await err(returned[1])
      } catch (error) {
        logger.debug?.(`${this.id.toString()}: job output not kept: ${String(error)}`)
      }
      // A mark without this view's secret is the program's output. A view that
      // threw may not have delivered all its stdout, and one whose output did
      // not all land is viewed again either way.
      const ended =
        finished && undelivered.length === 0
          ? JOB_END.exec(new TextDecoder('latin1').decode(held))
          : null
      if (ended !== null && ended[1] === secret) {
        const stdout = concat(kept[0])
        const stderr = concat(kept[1])
        const code = ended[2] ?? JOB_LOST
        if (code !== JOB_LOST)
          return { stdout, stderr: stderr.length > 0 ? stderr : null, exitCode: Number(code) }
        await this.stop(tag, SIGTERM)
        runner?.programSignaled(HANGUP_EXIT_CODE - 128)
        const said = new TextEncoder().encode(`mirage: ${this.id.toString()}: job lost\n`)
        return { stdout, stderr: concat([stderr, said]), exitCode: HANGUP_EXIT_CODE }
      }
      if (sent.out + sent.err !== before) wait = VIEW_RETRY_SECONDS
      await sleep(wait * 1000, signal)
      wait = Math.min(wait * 2, VIEW_RETRY_MAX_SECONDS)
    }
  }

  /**
   * Remove a viewed job's folder once its ending is kept: after its job's
   * ending is recorded (`ProcessHandle.afterEnding`), so a daemon that adopts
   * the job before then still reads how it ended; at once for a run no job
   * ending is recorded for. Mirrors Python's `MachineHandle._settled`.
   */
  private async settled(runner: ProcessHandle | null, folder: string): Promise<void> {
    if (runner?.afterEnding != null) runner.afterEnding.push(() => this.removeJob(folder))
    else await this.removeJob(folder)
  }

  /**
   * Remove a detached job's folder, bounded as a stop is; a box that does
   * not answer keeps it.
   */
  private async removeJob(folder: string): Promise<void> {
    const signal = AbortSignal.timeout(MACHINE_STOP_WAIT_SECONDS * 1000)
    try {
      await abortable(
        this.execArgv(
          ['/bin/sh', '-c', JOB_REMOVE, 'sh', folder],
          null,
          { ...this.config.env },
          '/',
          null,
          null,
          signal,
        ),
        signal,
      )
    } catch (error) {
      logger.debug?.(`${this.id.toString()}: ${folder} not removed: ${String(error)}`)
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
 * Count a view's stderr from what its job's console holds once a write failed
 * (`ProcessHandle.saved`): a chunk the console kept before its copy to the
 * terminal failed is not written again, one it never kept is. Stderr reaches
 * the console as it is written; stdout may still be on its way, so it counts
 * only what was written. Left as it was when nothing tells, or the view was
 * aborted. Mirrors Python's `_recount_errors`.
 */
async function recountErrors(
  runner: ProcessHandle | null,
  sent: { out: number; err: number },
  signal?: AbortSignal,
): Promise<void> {
  if (runner?.saved == null || signal?.aborted === true) return
  try {
    sent.err = (await runner.saved())[1]
  } catch (error) {
    logger.debug?.(`${runner.record.id.toString()}: job stderr not counted: ${String(error)}`)
  }
}

/**
 * Hold a detached job's output back while its daemon may no longer hold the
 * lease (`ProcessHandle.mayWrite`): its view counts the bytes unwritten and
 * views them again, here or at the daemon that adopts it. Throws
 * `WritesHeldError` when the output may not be written now. Mirrors Python's
 * `_hold_writes`.
 */
function holdWrites(runner: ProcessHandle | null, undelivered: unknown[]): void {
  if (runner?.mayWrite == null || runner.mayWrite()) return
  const held = new WritesHeldError(`${runner.record.id.toString()}: writes held`)
  undelivered.push(held)
  throw held
}

/**
 * The signal a cancelled run is stopped with in the box: the one its
 * process was stopped with, or the interrupt it took, else TERM. Mirrors
 * Python's `_stop_with`.
 */
function stopWith(runner: ProcessHandle | null): number {
  return runner?.signal ?? runner?.interrupted ?? SIGTERM
}

/**
 * Tell the job a run is where its program is about to run detached, before
 * it starts, so a daemon that outlives this one finds it. A job that could
 * not be told runs attached instead: one no daemon could find must not
 * outlive this one. Answers whether it may run detached: told, or no job to
 * tell. Mirrors Python's `_tell_detached`.
 */
async function tellDetached(
  runner: ProcessHandle,
  machine: MachineId,
  folder: string,
): Promise<boolean> {
  if (runner.onDetach === null) return true
  try {
    await runner.onDetach({
      machine: machine.toString(),
      folder,
      tag: runner.record.id.toString(),
      runtime: runner.record.runtime,
    })
  } catch (error) {
    logger.debug?.(`${machine.toString()}: detached job not recorded: ${String(error)}`)
    return false
  }
  return true
}

/**
 * Tell the job a run is that its program runs attached after all, so no
 * daemon awaits an adoption that never comes; a failed telling is logged,
 * and an adopter finds no folder and ends the job as lost. Mirrors Python's
 * `_untell_detached`.
 */
async function untellDetached(runner: ProcessHandle, machine: MachineId): Promise<void> {
  if (runner.onDetach === null) return
  try {
    await runner.onDetach(null)
  } catch (error) {
    logger.debug?.(`${machine.toString()}: detached job not unrecorded: ${String(error)}`)
  }
}

/**
 * How much of the stderr a job's viewer printed is the job's for sure: all
 * of it but a tail from a NUL that is, or may still grow into, the end mark
 * (`JOB_END`). Mirrors Python's `_unmarked`.
 *
 * @param held the stderr not yet delivered.
 */
function unmarked(held: Uint8Array): number {
  const at = held.lastIndexOf(0)
  if (at < 0) return held.length
  const tail = new TextDecoder('latin1').decode(held.slice(at))
  if (tail.length <= JOB_MARK.length) return JOB_MARK.startsWith(tail) ? at : held.length
  return JOB_END.test(tail) || JOB_END_PART.test(tail) ? at : held.length
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
