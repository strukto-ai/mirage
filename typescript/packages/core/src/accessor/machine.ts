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

import type { RunFn } from '../core/posix/types.ts'
import type { MachineTable } from '../execution/machine/table.ts'
import type { ByteSource } from '../io/types.ts'
import type { MachineHandle } from '../machine/handle.ts'
import type { MachineVFSConfig } from '../vfs/machine/config.ts'
import { Accessor } from './base.ts'

/**
 * The machines whose own files a mount shows, reached through the exec each
 * machine's handle already holds. Bound to the workspace's machines once it
 * has them, as a machine runtime is. Mirrors Python's `MachineAccessor`.
 */
export class MachineAccessor extends Accessor {
  private machines: MachineTable | null = null
  private chosen: string | null = null

  /** @param config which machines, and the root on each. */
  constructor(readonly config: MachineVFSConfig) {
    super()
  }

  /** The path on each machine that becomes the mount root. */
  get root(): string {
    return this.config.root ?? '/'
  }

  /**
   * Reach the workspace's machines.
   *
   * @param machines the workspace's machines.
   * @param fallback where a new name lands when the config names no
   *   `defaultMachine`.
   * @throws the config names a machine the workspace lacks, or a
   *   `defaultMachine` the mount does not show.
   */
  bindMachines(machines: MachineTable, fallback: string): void {
    for (const name of [...(this.config.machines ?? []), this.config.defaultMachine]) {
      if (name !== undefined) machines.get(name)
    }
    this.machines = machines
    const names = this.names()
    const chosen = this.config.defaultMachine
    if (chosen !== undefined && !names.includes(chosen))
      throw new Error(
        `machine: default_machine '${chosen}' is not one of the mount's machines: ${names.join(', ')}`,
      )
    this.chosen = chosen ?? (names.includes(fallback) ? fallback : (names[0] ?? null))
  }

  /**
   * The machines the mount shows, in the order `machines:` lists them.
   *
   * @throws the mount is not in a workspace with machines.
   */
  names(): string[] {
    if (this.machines === null || this.machines.names().length === 0)
      throw new Error('machine: the mount is not bound to machines')
    return [...(this.config.machines ?? this.machines.names())]
  }

  /** Where a new name lands when no program decides. */
  get defaultMachine(): string {
    const names = this.names()
    return this.chosen ?? names[0] ?? ''
  }

  /**
   * The handle of one of the mount's machines.
   *
   * @param machine its name under `machines:`.
   */
  handle(machine: string): MachineHandle {
    if (this.machines === null) throw new Error('machine: the mount is not bound to machines')
    return this.machines.get(machine)
  }

  /**
   * Run one shell line on a machine, at `/` in its environment: its exit
   * status, output and error output. A machine whose exec merges the two
   * (Daytona) gives its output as the error output of a line that failed.
   *
   * @param machine the machine's name.
   * @param command the line, as `/bin/sh -c` reads it.
   * @param stdin the bytes fed to the line.
   */
  async run(
    machine: string,
    command: string,
    stdin: ByteSource | null = null,
    bounded = false,
  ): Promise<[number | null, Uint8Array, Uint8Array]> {
    const handle = this.handle(machine)
    await handle.ensureConnected()
    const done = await handle.execLine(
      command,
      stdin,
      { ...handle.config.env },
      '/',
      undefined,
      bounded,
    )
    if (handle.joinsStreams && done.exitCode !== 0)
      return [done.exitCode, new Uint8Array(), done.stdout]
    return [done.exitCode, done.stdout, done.stderr]
  }

  /**
   * `run` on one machine, as the shared POSIX ops take it.
   *
   * @param machine the machine's name.
   */
  runner(machine: string): RunFn {
    return (command) => this.run(machine, command)
  }
}
