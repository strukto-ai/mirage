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
import { DOCKER_CONFIG_FIELDS, type DockerConfig } from './config.ts'
import { notRunningHint } from '@struktoai/mirage-core/machine/constants'
import { CONTAINER_GONE, DOCKER_HINT, ON_PAUSE, PAUSED_STATE, RUNNING_STATE } from './constants.ts'
import { reportedState } from '../program.ts'
import { ProgramMachine } from '../transport.ts'

/**
 * A container the user runs as a whole-line runtime.
 *
 * You start the container yourself; mirage only connects to it and
 * execs lines. The `docker` program is the transport (Docker Desktop,
 * colima, or a podman alias all work), so there is no SDK dependency
 * and no daemon socket wiring; each line is one `docker exec -i` with
 * the merged environment, the session cwd, real stdin, and separated
 * stderr.
 *
 * The container is yours: Mirage pauses it only when the workspace pauses
 * and its config says `onPause: 'pause'` or the call names it, and the next
 * connect unpauses it.
 */
export class DockerMachine extends ProgramMachine<DockerConfig> {
  static override readonly configFields: ConfigFields = DOCKER_CONFIG_FIELDS
  static override readonly provider = 'docker'
  protected override readonly pauses = true
  protected readonly program = 'docker'
  protected readonly installHint = DOCKER_HINT

  constructor(name: string, config?: DockerConfig) {
    super(name, config, DockerMachine.configFields)
    requireId('docker', 'container', this.config.container)
    checkOnPause('docker', this.config.onPause, ON_PAUSE)
  }

  /** The container docker runs it in. */
  override get instance(): string {
    return this.config.container
  }

  protected execWords(): readonly [readonly string[], readonly string[]] {
    return [['exec', '-i'], [this.config.container]]
  }

  async connect(): Promise<void> {
    const container = this.config.container
    const status = await this.execProgram(['inspect', '--format', '{{json .State}}', container])
    const state = reportedState(status, 'docker inspect', ['Status'])
    if (state === PAUSED_STATE) await this.changeState(['unpause', container])
    else if (state !== RUNNING_STATE)
      throw new Error(notRunningHint('container', container, state, {}))
    this.reached = true
  }

  /** Whether the config says `onPause: 'pause'`. */
  override configAsksToPause(): boolean {
    return this.config.onPause === 'pause'
  }

  /** Freeze the container's processes, which frees its CPU and keeps its memory; the next connect unpauses it. */
  protected override async pauseMachine(): Promise<void> {
    await this.changeState(['pause', this.config.container], CONTAINER_GONE)
  }
}

registerMachine('docker', DockerMachine)
