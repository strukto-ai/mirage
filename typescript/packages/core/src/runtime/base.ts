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
import type { PathSpec } from '../types.ts'
import { Activity } from '../utils/activity.ts'
import { coerceRuntimeConfig, type RuntimeConfig, type RuntimeOptions } from './config.ts'
import type { WorkspaceBinding } from './binding.ts'
import { UnsupportedExecutionError } from './errors.ts'
import { isLineExecutor, isProcessExecutor, isStreamingProcess } from './mixin.ts'
import type {
  ExecutionKind,
  FilesystemOperation,
  OutputFn,
  RuntimeCapabilities,
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
 * (run), LineExecutor takes whole lines (runLine), ProcessExecutor runs
 * an argv (runProcess).
 *
 * Every runtime is constructed the same way (captures, config); each
 * subclass hands the base its class-default captures and its config key
 * list, so a config field the runtime does not have fails loud
 * (config_cls in Python).
 */
export abstract class Runtime<E = unknown> {
  abstract readonly name: string
  readonly captures: readonly string[]
  /**
   * Which entry points this runtime's code has to the outside world (see
   * RuntimeReach): 'workspace' when the workspace dispatch is its only one,
   * as the bridged engines (monty, pyodide, quickjs) and the vfs
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
    configKeys: readonly string[] = [],
  ) {
    this.captures =
      options.captures !== undefined ? options.captures.slice() : defaultCaptures.slice()
    this.config = coerceRuntimeConfig(options.config, configKeys)
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

  get capabilities(): RuntimeCapabilities {
    return {
      languages: [],
      shell: isLineExecutor(this),
      process: isProcessExecutor(this),
      reach: this.reach,
      filesystem: [...this.filesystem],
    }
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
   *   where a streamed process writes its output, absent to collect it in
   *   the result.
   */
  async execute(
    paths: readonly PathSpec[],
    texts: readonly string[],
    ctx: Context,
    opts: { kind?: ExecutionKind; output?: OutputFn } = {},
  ): Promise<RunResult> {
    const release = this.admit()
    try {
      const kind = opts.kind ?? 'code'
      const capture = this.binding?.capture()
      const restricted = capture?.restrictedMounts ?? []
      if (this.reach !== 'workspace' && restricted.length > 0 && !this.servesSession(restricted))
        return {
          stdout: new Uint8Array(),
          exitCode: 127,
          stderr: new TextEncoder().encode(
            `${this.name}: runtime cannot enforce this session's file restrictions\n`,
          ),
        }
      const engine = await this.engine()
      if (capture === undefined)
        return await this.runAs(kind, engine, [...paths], [...texts], ctx, opts.output)
      const { vfs, session } = capture.ctx
      const processes = ctx.processes ?? capture.ctx.processes
      const runCtx: Context = {
        ...ctx,
        ...(session !== undefined ? { session } : {}),
        ...(processes !== undefined ? { processes } : {}),
      }
      if (vfs === undefined) delete runCtx.vfs
      else runCtx.vfs = vfs
      return await capture.scope.run(() =>
        this.runAs(kind, engine, [...paths], [...texts], runCtx, opts.output),
      )
    } finally {
      release()
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
  ): Promise<RunResult> {
    if (kind === 'process' && texts.length === 0) throw new Error('process argv must not be empty')
    if (kind === 'code') return this.run(engine, paths, texts, ctx)
    if (kind === 'line' && isLineExecutor(this)) return this.runLine(engine, paths, texts, ctx)
    if (kind === 'process' && output !== undefined) {
      if (isStreamingProcess(this)) return this.runStream(engine, paths, texts, ctx, output)
    } else if (kind === 'process' && isProcessExecutor(this)) {
      return this.runProcess(engine, paths, texts, ctx)
    }
    const shown = output !== undefined ? 'stream' : kind
    throw new UnsupportedExecutionError(`${this.name}: ${shown} execution is unsupported`)
  }

  /**
   * Run code in this runtime's language; only a language runtime has one.
   *
   * @param _engine the install's engine.
   * @param _paths the script operand, if any.
   * @param _texts the program's argv.
   * @param _ctx the run's context.
   */
  run(_engine: E, _paths: PathSpec[], _texts: string[], _ctx: Context): Promise<RunResult> {
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

/** A workspace runtimes-list entry: an instance or a name shorthand. */
export type RuntimeEntry = Runtime | string
