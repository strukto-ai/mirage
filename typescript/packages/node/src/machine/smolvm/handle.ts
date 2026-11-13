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

import { checkOnPause, requireId } from '@struktoai/mirage-core/machine/config'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { SMOLVM_CONFIG_FIELDS, type SmolvmConfig } from './config.ts'
import { notRunningHint } from '@struktoai/mirage-core/machine/constants'
import {
  MACHINE_GONE,
  ON_PAUSE,
  PAUSED_STATE,
  RUNNING_STATE,
  SMOLVM_HINT,
  STATE_HINTS,
} from './constants.ts'
import { reportedState } from '../program.ts'
import { ProgramMachine } from '../transport.ts'

/**
 * A microVM the user runs as a whole-line runtime.
 *
 * You start the machine yourself; mirage only connects to it and
 * execs lines. The `smolvm` program is the transport, so there is no SDK
 * dependency and no daemon socket wiring; each line is one `smolvm
 * machine exec` with the merged environment, the session cwd, real
 * stdin, and separated stderr.
 *
 * Unlike a container, the guest runs its own kernel, so the line sees
 * that kernel's filesystem and nothing of the host's except what the
 * machine was given at boot (`--volume`). Serve the workspace inside
 * the guest at the host's mount prefixes, the same contract every
 * provider in this family carries.
 *
 * Mirage pauses the machine only when the workspace pauses and its config
 * says `onPause: 'pause'` or the call names it, and the next connect
 * resumes it.
 */
export class SmolvmMachine extends ProgramMachine<SmolvmConfig> {
  static override readonly configFields: ConfigFields = SMOLVM_CONFIG_FIELDS
  static override readonly provider = 'smolvm'
  protected override readonly pauses = true
  protected readonly program = 'smolvm'
  protected readonly installHint = SMOLVM_HINT

  constructor(name: string, config?: SmolvmConfig) {
    super(name, config, SmolvmMachine.configFields)
    requireId('smolvm', 'machine', this.config.machine)
    checkOnPause('smolvm', this.config.onPause, ON_PAUSE)
  }

  /** The VM smolvm runs it in. */
  override get instance(): string {
    return this.config.machine
  }

  protected execWords(): readonly [readonly string[], readonly string[]] {
    return [['machine', 'exec', '--name', this.config.machine, '-i'], ['--']]
  }

  /**
   * Probe the machine, resuming a paused one and refusing any other state
   * that cannot take a line.
   *
   * `machine exec` would start a stopped machine on its own, but this
   * family never boots a machine, so a machine that is neither running nor
   * paused is an error rather than a boot.
   */
  async connect(): Promise<void> {
    const machine = this.config.machine
    const status = await this.execProgram(['machine', 'status', '--name', machine, '--json'])
    const state = reportedState(status, 'smolvm machine status', ['state'])
    if (state === PAUSED_STATE) await this.changeState(['machine', 'resume', '--name', machine])
    else if (state !== RUNNING_STATE)
      throw new Error(notRunningHint('machine', machine, state, STATE_HINTS))
    this.reached = true
  }

  /** Whether the config says `onPause: 'pause'`. */
  override configAsksToPause(): boolean {
    return this.config.onPause === 'pause'
  }

  /** Save the machine's memory and disks durably, then stop its VM; the next connect resumes it. */
  protected override async pauseMachine(): Promise<void> {
    await this.changeState(['machine', 'pause', '--name', this.config.machine], MACHINE_GONE)
  }
}

registerMachine('smolvm', SmolvmMachine)
