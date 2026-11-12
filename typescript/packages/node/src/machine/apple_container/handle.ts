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

import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { requireId } from '@struktoai/mirage-core/machine/config'
import { APPLE_CONTAINER_CONFIG_FIELDS, type AppleContainerConfig } from './config.ts'
import { APPLE_CONTAINER_HINT, RUNNING_STATE, STATE_HINTS } from './constants.ts'
import { notRunningHint } from '@struktoai/mirage-core/machine/constants'
import { reportedState } from '../program.ts'
import { ProgramMachine } from '../transport.ts'

/**
 * A container under Apple's `container` tool.
 *
 * You start the container yourself; mirage only connects to it and
 * execs lines. The `container` program is the transport, so there is no
 * SDK dependency and no XPC wiring; each line is one `container exec`
 * with the merged environment, the session cwd, real stdin, and
 * separated stderr.
 *
 * Each container is its own lightweight VM with its own Linux kernel,
 * so, as in a smolvm guest, the line sees nothing of the host's
 * filesystem except what the container was given at start
 * (`--volume`). Serve the workspace inside it at the host's mount
 * prefixes, the same contract every provider in this family carries.
 * The image needs a POSIX /bin/sh, which every argv runs under (EXEC_PRELUDE).
 *
 * One machine is one container, so an agent gets a VM of its own as a
 * machine of its own, which a policy route sends its session to.
 */
export class AppleContainerMachine extends ProgramMachine<AppleContainerConfig> {
  static override readonly configFields: ConfigFields = APPLE_CONTAINER_CONFIG_FIELDS
  static override readonly provider = 'apple_container'
  protected readonly program = 'container'
  protected readonly installHint = APPLE_CONTAINER_HINT

  constructor(name: string, config?: AppleContainerConfig) {
    super(name, config, AppleContainerMachine.configFields)
    requireId('apple_container', 'container', this.config.container)
  }

  /** The container Apple's container runs it in. */
  override get instance(): string {
    return this.config.container
  }

  protected execWords(): readonly [readonly string[], readonly string[]] {
    return [['exec', '-i'], [this.config.container]]
  }

  /**
   * Refuse a container in any state that cannot take a line.
   *
   * `container exec` refuses a container that is not running as well;
   * probing up front names the state and how to recover.
   */
  async connect(): Promise<void> {
    const container = this.config.container
    const status = await this.execProgram(['inspect', container])
    const state = reportedState(status, 'container inspect', [0, 'status', 'state'])
    if (state !== RUNNING_STATE)
      throw new Error(notRunningHint('container', container, state, STATE_HINTS))
  }
}

registerMachine('apple_container', AppleContainerMachine)
