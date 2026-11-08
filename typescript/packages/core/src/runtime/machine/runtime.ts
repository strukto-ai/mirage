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
import type { MachineTable } from '../../execution/machine/table.ts'
import type { MachineId } from '../../execution/types.ts'
import type { MachineHandle } from '../../machine/handle.ts'
import type { PathSpec } from '../../types.ts'
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
 * `/bin/sh -c`. Mirrors Python's `MachineRuntime`.
 */
export class MachineRuntime
  extends Runtime<undefined>
  implements LineExecutorMixin<undefined>, ProcessExecutorMixin<undefined>
{
  readonly name = 'machine'
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

  override get machine(): MachineId | null {
    if (this.machines === null || this.defaultMachine === null) return null
    return this.machines.get(this.defaultMachine).id
  }

  override machineFor(ctx: Context): MachineId | null {
    return this.handle(ctx).id
  }

  /**
   * The provider of the machine the run goes to, as a refusal of its mounts
   * names it; the runtime's name when it names none.
   */
  override voice(ctx: Context): string {
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

  runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output: OutputFn | undefined,
    errors?: OutputFn,
  ): Promise<RunResult> {
    return this.handle(ctx).run(texts, ctx, this.binding, output ?? null, errors ?? null)
  }

  /** Land what a line's programs left on every machine. */
  override async settle(): Promise<void> {
    for (const handle of this.machines?.handles() ?? []) await handle.settle()
  }
}
