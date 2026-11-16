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
  currentCaller,
  isProgramInvocation,
  runWithCaller,
  voiceName,
} from '../context/session_context.ts'
import { isAborting } from '../errors/fs.ts'
import type { ProcessHandle } from '../execution/process/handle.ts'
import type { MachineName } from '../execution/types.ts'
import { SharedInput } from '../io/async_line_iterator.ts'
import { liveEgress } from '../io/gateway.ts'
import { FORK_FAILED, FORK_FAILED_STATUS } from '../shell/constants.ts'
import { endsLine } from '../shell/helpers.ts'
import { shellJoin } from '../shell/join.ts'
import type { PathSpec } from '../types.ts'
import { Activity } from '../utils/activity.ts'
import { refusedRun, type WorkspaceBinding } from './binding.ts'
import {
  coerceRuntimeConfig,
  type ConfigFields,
  type RuntimeConfig,
  type RuntimeOptions,
} from './config.ts'
import { expandCaptures } from './constants.ts'
import { UnsupportedExecutionError } from './errors.ts'
import { isLineExecutor, isProcessExecutor } from './mixin.ts'
import type {
  ExecutionKind,
  FilesystemOperation,
  OutputFn,
  RunResult,
  RuntimeReach,
} from './types.ts'

/**
 * An engine the workspace can route commands or whole lines to.
 *
 * A runtime is to its commands what the regex engine is to grep: the
 * machinery inside a handler, invisible to the dispatcher. Each runtime
 * declares the command names it captures; a command binds to the first
 * runtime in the workspace's ordered list that captures it. Its hooks take
 * what a handler takes, `(engine, paths, texts, ctx)`: the engine (`E`) is
 * built once by `openEngine`; a runtime with none declares
 * `Runtime<undefined>`.
 *
 * The base holds only what every tier shares: the registry name, the
 * captured command names, the coerced config and the engine. What a
 * runtime can DO is declared by its tier and mixins, detected by type and
 * never by probing: LanguageRuntime interprets code in its language
 * (run), LineExecutorMixin takes whole lines (runLine), ProcessExecutorMixin runs
 * an argv (runProcess).
 *
 * Every runtime is constructed the same way (captures, config); each
 * subclass hands the base its class-default captures and its config key
 * list, so a config field the runtime does not have fails loud
 * (config_cls in Python).
 */
export abstract class Runtime<E = unknown> {
  /**
   * The keys its config takes, camelCase, each with its type: what a saved
   * runtime's fields are. Python reads the same off its `config_cls`
   * dataclass.
   */
  static readonly configFields: ConfigFields = {}
  /** The machine it runs for: its registry name until a `machines:` entry names it. */
  abstract name: string
  readonly captures: readonly string[]
  /**
   * Which entry points this runtime's code has to the outside world (see
   * RuntimeReach): 'workspace' when the workspace dispatch is its only one,
   * as the bridged engines (monty, pyodide, quickjs) and the workspace
   * routing marker declare, 'process' or 'remote' when the code can
   * act around that gate. The default is 'process', the no-promise
   * claim, so a custom runtime must declare a narrower reach
   * explicitly rather than inherit it. Embedders read the aggregate:
   * only a world in which every runtime reaches 'workspace' makes "agent
   * code cannot bypass mount modes and policy" a true statement,
   * which is what the dsh adapter's sandbox claim is built from; one
   * wider runtime voids it.
   */
  readonly reach: RuntimeReach = 'process'
  readonly filesystem: readonly FilesystemOperation[] = []
  /** The runtime's coerced implementation knobs. */
  config: RuntimeConfig
  protected binding: WorkspaceBinding | null = null
  private readonly activity = new Activity()
  private retired = false
  private opening: Promise<E> | null = null
  private closing: Promise<void> | null = null

  constructor(
    options: RuntimeOptions<RuntimeConfig> = {},
    defaultCaptures: readonly string[] = [],
    configFields: ConfigFields = {},
  ) {
    this.captures = expandCaptures(options.captures ?? defaultCaptures)
    this.config = coerceRuntimeConfig(options.config, Object.keys(configFields))
  }

  /**
   * The machine this runtime runs its programs on, which their process
   * records name; null for the workspace's own.
   */
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get machine(): MachineName | null {
    return null
  }

  /**
   * The name a refusal of its runs speaks in: the runtime's. Mirrors
   * Python's `Runtime.refusal_name`.
   */
  get refusalName(): string {
    return this.name
  }

  /** Whether workspace file mutations already invalidate through dispatch. */
  get fileEffectsDispatched(): boolean {
    return this.reach === 'workspace'
  }

  /**
   * Land the file writes this runtime still holds for a line. The executor
   * calls it when a line ends, however it ended, so the line's writes are
   * in the workspace by the time it returns. Holds none by default; a
   * sandbox serving the workspace over SFTP lands what its servers hold.
   */
  settle(): Promise<void> {
    return Promise.resolve()
  }

  /** Attach workspace services; a runtime instance belongs to one workspace. */
  bind(binding: WorkspaceBinding): void {
    if (this.retired)
      throw new Error(`${this.name}: runtime was removed from its workspace; construct a new one`)
    if (this.binding !== null && this.binding !== binding)
      throw new Error(`${this.name}: runtime is already bound to another workspace`)
    this.binding = binding
  }

  /**
   * Run once, as the session the bound workspace captures. The capture
   * supplies the files (`ctx.vfs`, judged as the program's own calls) and
   * the session; the caller's `ctx` the rest.
   *
   * @param paths the path operands (a script).
   * @param texts the text operands (argv; a process's program first).
   * @param ctx the run's context.
   * @param opts `kind`: code in the runtime's language (the default), a
   *   whole line (`sh -c` with `ctx.flags.c`), or a process; `output`:
   *   where the run writes its output as it comes, absent to collect it in
   *   the result; `errors`: the same for its stderr.
   */
  async execute(
    paths: readonly PathSpec[],
    texts: readonly string[],
    ctx: Context,
    opts: { kind?: ExecutionKind; output?: OutputFn; errors?: OutputFn } = {},
  ): Promise<RunResult> {
    const release = this.admit()
    try {
      const kind = opts.kind ?? 'code'
      const capture = this.binding?.capture()
      const restricted = capture?.restrictedMounts ?? []
      if (this.reach !== 'workspace' && restricted.length > 0 && !this.servesSession(restricted))
        return refusedRun(
          this.refusalName,
          "runtime cannot enforce this session's file restrictions",
        )
      // A process on this machine opens its connections around the gateway,
      // so a workspace whose network is limited, or whose policies judge
      // each connection, runs none.
      if (this.reach === 'process') {
        for (const egress of liveEgress()) {
          if (egress.rule !== null || (await egress.hooked))
            return refusedRun(this.refusalName, "runtime cannot enforce this workspace's network")
        }
      }
      const engine = await this.engine()
      if (capture === undefined)
        return await this.runAs(kind, engine, [...paths], [...texts], ctx, opts.output, opts.errors)
      const { vfs, session } = capture.ctx
      const processes = ctx.processes ?? capture.ctx.processes
      const runCtx: Context = {
        ...ctx,
        ...(session !== undefined ? { session } : {}),
        ...(processes !== undefined ? { processes } : {}),
      }
      if (vfs === undefined) delete runCtx.vfs
      else runCtx.vfs = vfs
      return await runWithCaller(capture.caller, () =>
        this.asProgram(kind, [...texts], runCtx, (programCtx) =>
          this.runAs(kind, engine, [...paths], [...texts], programCtx, opts.output, opts.errors),
        ),
      )
    } finally {
      release()
    }
  }

  /**
   * Run a program past the workspace's reach as a process of its own, as
   * bash forks one: the process started for it when it is that process's
   * one command (`ProcessHandle.take`) or the last a forked shell runs
   * (`endsLine`), as bash execs it in the shell's place, else a child of the
   * running one, in its group, on this runtime's machine. Its record names
   * the processes its command's substitutions started, each `<( )` by its
   * descriptor (`fd`), each `$( )` as part of its arguments (`argv`), and the
   * stage writing its pipe while it reads its stage's (`stdin`). A run the
   * workspace reaches stays
   * in its shell's process, as does one outside a process. A child stopped
   * with its shell gets the signal the shell was stopped with, or the
   * interrupt it took; one stopped alone answers 128 plus its signal, and
   * its shell goes on. Mirrors Python's `Runtime._as_program`.
   *
   * @param kind what is asked, which names the program.
   * @param texts the text operands.
   * @param ctx the run's context.
   * @param run the program, to its end, under the context it is given.
   */
  private async asProgram(
    kind: ExecutionKind,
    texts: string[],
    ctx: Context,
    run: (ctx: Context) => Promise<RunResult>,
  ): Promise<RunResult> {
    const processes = this.binding?.processes ?? null
    const { process: shell, session, evaluation } = currentCaller()
    if (this.reach === 'workspace' || processes === null || shell == null || session == null)
      return run(ctx)
    const machine = this.machine
    const instance = machine === null ? null : (processes.machineInstance?.(machine) ?? null)
    const line = ctx.flags.c
    const command =
      kind === 'line' && typeof line === 'string'
        ? line
        : kind === 'process'
          ? shellJoin(texts)
          : shellJoin([ctx.spec?.name ?? this.name, ...(ctx.argv ?? [])])
    const writers = evaluation?.frame.writers ?? []
    const fd: Record<number, number> = {}
    for (const [path, pid] of writers)
      if (path !== null) fd[Number(path.slice(path.lastIndexOf('/') + 1))] = pid
    const argv = writers.filter(([path]) => path === null).map(([, pid]) => pid)
    const given = ctx.stdin instanceof SharedInput ? ctx.stdin.lines.input : ctx.stdin
    const stdin =
      evaluation?.frame.stdin != null && given === evaluation.frame.stdin
        ? (shell.record.stdin ?? null)
        : null
    const node = session.lineNode
    // A line's own process is its session's `$$`, which each of its lines
    // takes in turn, so it stays the shell; and only the shell's own input
    // runs its last command in place, not a line `eval`, `source` or a trap
    // runs, each of which names its own parse.
    if (
      node !== null &&
      shell.record.parent !== null &&
      (session.parseHead === null ||
        session.parseHead === `${voiceName(session)}: command substitution: `) &&
      (session.exitTrap === null || session.exitTrapInherited) &&
      !isProgramInvocation(session) &&
      endsLine(node)
    )
      shell.oneCommand = true
    if (shell.take(machine, instance, command, fd, argv)) return run(ctx)
    const stop = new AbortController()
    const signal =
      ctx.signal === undefined ? stop.signal : AbortSignal.any([ctx.signal, stop.signal])
    let done: RunResult | undefined
    let child: ProcessHandle
    try {
      child = processes.start({
        sessionId: session.sessionId,
        command,
        cwd: ctx.cwd,
        run: async () => {
          done = await run({ ...ctx, signal })
          return done.exitCode
        },
        cancel: () => {
          stop.abort()
        },
        parent: shell.record.id.pid,
        limit: session.processes.max,
        machine,
        program: true,
        stdin,
        fd,
        argv,
      })
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EAGAIN') throw error
      return {
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(FORK_FAILED),
        exitCode: FORK_FAILED_STATUS,
      }
    }
    const stopped = (): void => {
      child.terminate(shell.signal ?? shell.interrupted ?? 9)
    }
    ctx.signal?.addEventListener('abort', stopped, { once: true })
    try {
      const code = await child.task
      return done ?? { stdout: new Uint8Array(), stderr: null, exitCode: code }
    } catch (error) {
      if (ctx.signal?.aborted === true || !isAborting(error)) throw error
      // The child alone was stopped (`kill` of its pid); its shell goes on
      // with its status.
      return { stdout: new Uint8Array(), stderr: null, exitCode: 128 + (child.signal ?? 9) }
    } finally {
      ctx.signal?.removeEventListener('abort', stopped)
    }
  }

  /** Hand the run to the capability its kind asks for. */
  private async runAs(
    kind: ExecutionKind,
    engine: E,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output: OutputFn | undefined,
    errors: OutputFn | undefined,
  ): Promise<RunResult> {
    if (kind === 'process' && texts.length === 0) throw new Error('process argv must not be empty')
    if (kind === 'code') return this.run(engine, paths, texts, ctx, output, errors)
    if (kind === 'line' && isLineExecutor(this))
      return this.runLine(engine, paths, texts, ctx, output, errors)
    if (kind === 'process' && isProcessExecutor(this))
      return this.runProcess(engine, paths, texts, ctx, output, errors)
    throw new UnsupportedExecutionError(`${this.name}: ${kind} execution is unsupported`)
  }

  /**
   * Run code in this runtime's language; only a language runtime has one.
   *
   * @param _engine the install's engine.
   * @param _paths the script operand, if any.
   * @param _texts the program's argv.
   * @param _ctx the run's context.
   * @param _output receives stdout as it comes; undefined returns it in
   *   the result.
   * @param _errors the same for stderr.
   */
  run(
    _engine: E,
    _paths: PathSpec[],
    _texts: string[],
    _ctx: Context,
    _output?: OutputFn,
    _errors?: OutputFn,
  ): Promise<RunResult> {
    return Promise.reject(
      new UnsupportedExecutionError(`${this.name}: code execution is unsupported`),
    )
  }

  /** Build the engine every run reuses, once; the default is none. */
  protected openEngine(): Promise<E> {
    return Promise.resolve(undefined as E)
  }

  /**
   * Release what `openEngine` built.
   *
   * @param _engine the engine.
   */
  protected closeEngine(_engine: E): Promise<void> {
    return Promise.resolve()
  }

  /** The engine, opened once and shared; a failed open is retried. */
  engine(): Promise<E> {
    const opening = (this.opening ??= this.openEngine())
    return opening.catch((err: unknown) => {
      if (this.opening === opening) this.opening = null
      throw err
    })
  }

  /**
   * Whether every restricted mount is served through this caller's gate.
   *
   * @param _restrictedMounts the mounts the session restricts.
   */
  protected servesSession(_restrictedMounts: readonly string[]): boolean {
    return false
  }

  /** Count one unit of work, refused once the runtime is retired. */
  admit(): () => void {
    if (this.retired) throw new Error(`${this.name}: runtime was removed from the workspace`)
    return this.activity.acquire()
  }

  /** Refuse new executions and binds, then wait for running ones. */
  async retire(): Promise<void> {
    this.retired = true
    await this.activity.wait()
  }

  /**
   * Close the engine, when one was opened. A close that comes while another
   * runs waits for that one rather than finding nothing left to close.
   */
  async close(): Promise<void> {
    const closing = (this.closing ??= this.dropEngine())
    try {
      await closing
    } finally {
      if (this.closing === closing) this.closing = null
    }
  }

  private async dropEngine(): Promise<void> {
    const opening = this.opening
    this.opening = null
    if (opening === null) return
    let engine: E
    try {
      engine = await opening
    } catch (err) {
      console.debug(`${this.name}: engine never opened`, err)
      return
    }
    await this.closeEngine(engine)
  }
}
