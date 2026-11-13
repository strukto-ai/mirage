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

import type { Context } from '../../commands/config.ts'
import { currentCaller } from '../../context/session_context.ts'
import type { MachineTable } from '../../execution/machine/table.ts'
import type { MachineName } from '../../execution/types.ts'
import { FIFO_PREFIX, RUN_DRAIN_SECONDS } from '../../machine/constants.ts'
import type { MachineHandle } from '../../machine/handle.ts'
import type { PathSpec } from '../../types.ts'
import { shellQuote } from '../../utils/quote.ts'
import type { Files } from '../../workspace/files.ts'
import { Runtime } from '../base.ts'
import type { RuntimeOptions } from '../config.ts'
import { EXTERNAL_COMMANDS } from '../constants.ts'
import {
  LINE_EXECUTOR,
  PROCESS_EXECUTOR,
  type LineExecutorMixin,
  type ProcessExecutorMixin,
} from '../mixin.ts'
import type { OutputFn, RunResult } from '../types.ts'

/**
 * Stream a process substitution into the named pipe on the machine that
 * stands for it, while the pipe is still there. Mirrors Python's `_feed`.
 */
async function feed(
  handle: MachineHandle,
  files: Files,
  text: string,
  fifo: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<RunResult> {
  const quoted = shellQuote(fifo)
  return handle.execLine(
    `[ -p ${quoted} ] && exec cat > ${quoted}`,
    await files.read(text, { stream: true }),
    env,
    '/',
    signal,
  )
}

/**
 * Remove the named pipes a run's substitutions fed, then stop their feeds,
 * each given `RUN_DRAIN_SECONDS` to end, whatever the machine answers.
 * Mirrors Python's `_unfeed`.
 */
async function unfeed(
  handle: MachineHandle,
  feeds: (readonly [string, Promise<void>])[],
  env: Record<string, string>,
  stop: AbortController,
): Promise<void> {
  try {
    for (const [fifo] of feeds) {
      const quoted = shellQuote(fifo)
      try {
        await handle.execLine(`exec 3<>${quoted}; exec 3>&-; rm -f ${quoted}`, null, env, '/')
      } catch (err) {
        console.debug(`${fifo}: not removed`, err)
      }
    }
    if (feeds.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(feeds.map(([, fed]) => fed)),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, RUN_DRAIN_SECONDS * 1000))),
      ])
      clearTimeout(timer)
    }
  } finally {
    stop.abort()
    await Promise.all(feeds.map(([, fed]) => fed))
  }
}

/** A machine entry's options: a runtime's, and the machine a run goes to by default. */
export interface MachineOptions extends RuntimeOptions {
  machine?: string
}

/**
 * Run a machine's own programs through that machine's exec.
 *
 * The runtime is the same whatever the provider: the machine handle a
 * workspace declares under `machines:` is the transport. A run goes to the
 * machine its route names (`execute({ machine })`, a policy's Route), else
 * to this entry's `machine`. Captures default to `@external`, the programs
 * nothing in Mirage resolves; an explicit `@line` sends whole lines, run as
 * `/bin/sh -c`. Mirrors Python's `RemoteRuntime`.
 */
export class RemoteRuntime
  extends Runtime<undefined>
  implements LineExecutorMixin<undefined>, ProcessExecutorMixin<undefined>
{
  /** `remote`, or `remote:<machine>` for an entry with a machine, so a workspace can hold one per machine. */
  readonly name: string
  // Programs execute on the machine and act on its world (its filesystem,
  // its network); the workspace gate never sees those effects, however well
  // isolated the machine itself is.
  override readonly reach = 'remote'
  readonly [LINE_EXECUTOR] = true as const
  readonly [PROCESS_EXECUTOR] = true as const
  /** The machine a run goes to when its route names none. */
  readonly defaultMachine: string | null
  private machines: MachineTable | null = null

  constructor(options: MachineOptions = {}) {
    const { machine, ...rest } = options
    super(rest, [EXTERNAL_COMMANDS])
    this.name = machine === undefined ? 'remote' : `remote:${machine}`
    this.defaultMachine = machine ?? null
  }

  /**
   * Reach the workspace's machines.
   *
   * Throws:
   *   Error: the entry's `machine` is none of them.
   */
  bindMachines(machines: MachineTable): void {
    if (this.defaultMachine !== null) machines.get(this.defaultMachine)
    this.machines = machines
  }

  /**
   * The machine one run goes to.
   *
   * Throws:
   *   Error: no machine is named, or the workspace has none by that name.
   */
  handle(ctx: Context): MachineHandle {
    const name = ctx.machine ?? this.defaultMachine
    if (name === null)
      throw new Error(
        `${this.name}: no machine to run on; name one with the entry's machine or the line's route`,
      )
    if (this.machines === null) throw new Error(`${this.name}: runtime is not in a workspace`)
    return this.machines.get(name)
  }

  override get machine(): MachineName | null {
    if (this.machines === null || this.defaultMachine === null) return null
    return this.machines.get(this.defaultMachine).machine
  }

  override machineFor(ctx: Context): MachineName | null {
    return this.handle(ctx).machine
  }

  /**
   * The provider of the machine the run goes to, as a refusal of its mounts
   * names it; the runtime's name when it names none.
   */
  override refusalName(ctx: Context): string {
    const name = ctx.machine ?? this.defaultMachine
    if (this.machines === null || name === null || !this.machines.names().includes(name))
      return this.name
    return this.machines.get(name).provider
  }

  override get fileEffectsDispatched(): boolean {
    const handles = this.machines?.handles() ?? []
    return handles.length > 0 && handles.every((h) => h.fileEffectsDispatched(this.binding))
  }

  protected override servesSession(restrictedMounts: readonly string[], ctx: Context): boolean {
    return this.handle(ctx).servesSession(restrictedMounts)
  }

  /**
   * Run one raw line on the machine, connecting once.
   *
   * The line, cwd, and paths pass through verbatim: the machine is expected
   * to serve the workspace at the same prefixes as the host, so nothing is
   * rewritten. The session environment merges over the machine's.
   *
   * @param _engine none; a machine keeps its own connection.
   * @param _paths unused; the line names its paths.
   * @param _texts unused.
   * @param ctx the line in `flags.c`, the bytes piped into it, the session
   *   environment and working directory, the signal that stops it.
   * @param output receives stdout as it arrives.
   * @param errors receives stderr as it arrives.
   */
  runLine(
    _engine: undefined,
    _paths: PathSpec[],
    _texts: string[],
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    const line = ctx.flags.c
    return this.handle(ctx).run(
      ['/bin/sh', '-c', typeof line === 'string' ? line : ''],
      ctx,
      this.binding,
      output ?? null,
      errors ?? null,
    )
  }

  /**
   * Run one program on the machine. A process substitution it reads by path
   * (`node read.js <(python3 gen.py)`) becomes a named pipe on that machine,
   * which Mirage feeds while the program runs, as bash hands a program a pipe
   * it shares. Mirrors Python's `run_process`.
   */
  async runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output: OutputFn | undefined,
    errors?: OutputFn,
  ): Promise<RunResult> {
    const handle = this.handle(ctx)
    const env = { ...handle.config.env }
    const { evaluation } = currentCaller()
    const reads = new Set(
      (evaluation?.frame.writers ?? []).flatMap(([path]) => (path === null ? [] : [path])),
    )
    const argv = [...texts]
    const feeds: (readonly [string, Promise<void>])[] = []
    const stop = new AbortController()
    try {
      for (const [at, text] of texts.entries()) {
        if (ctx.vfs == null || !reads.has(text)) continue
        await handle.ensureConnected(ctx.signal)
        const fifo = `${FIFO_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`
        const made = await handle.execLine(`mkfifo -m 600 ${shellQuote(fifo)}`, null, env, '/')
        if (made.exitCode !== 0) {
          console.debug(`${fifo}: mkfifo exited ${String(made.exitCode)}`)
          continue
        }
        argv[at] = fifo
        feeds.push([
          fifo,
          feed(handle, ctx.vfs, text, fifo, env, stop.signal).then(
            () => undefined,
            (err: unknown) => {
              if (!stop.signal.aborted) console.debug(`${fifo}: feed failed`, err)
            },
          ),
        ])
      }
      return await handle.run(argv, ctx, this.binding, output ?? null, errors ?? null)
    } finally {
      await unfeed(handle, feeds, env, stop)
    }
  }

  /** Land what a line's programs left on every machine. */
  override async settle(): Promise<void> {
    for (const handle of this.machines?.handles() ?? []) await handle.settle()
  }
}
