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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { MachineHandle, logger } from '@struktoai/mirage-core/machine/handle'
import { ON_PAUSE, PAUSED_STATE } from './constants.ts'
import { checkOnPause, requireId } from '@struktoai/mirage-core/machine/config'
import { decodeOutput, encodeOutput, wrapLine } from '@struktoai/mirage-core/machine/constants'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'
import type { DaytonaSdk } from './sdk.ts'
import { DAYTONA_CONFIG_FIELDS, type DaytonaConfig } from './config.ts'
import type { Daytona, Sandbox } from '@daytonaio/sdk'

/**
 * A Daytona sandbox the user runs as a whole-line runtime.
 *
 * You create the machine yourself (dashboard, `daytona sandbox
 * create`, or the SDK); mirage only connects by `sandboxId` and execs
 * lines. `apiKey` falls back to DAYTONA_API_KEY. Daytona's exec takes
 * no stdin and reports combined output once the command ends, so a run
 * given input is refused (126) before it starts, and the joined answer is
 * written once through the run's stdout at the end (`joinsStreams`). The output is base64-encoded in the
 * sandbox, since the exec returns it as text (`encodeOutput`: the machine
 * needs dd and base64). close() releases the SDK client and never
 * touches the machine. Mirage pauses the sandbox only when the workspace
 * pauses and its config says `onPause: 'pause'` or the call names it, and
 * the next connect starts it again.
 */
export class DaytonaMachine extends MachineHandle<DaytonaConfig> {
  static override readonly configFields: ConfigFields = DAYTONA_CONFIG_FIELDS
  static override readonly provider = 'daytona'
  protected override readonly pauses = true
  override readonly takesInput = false
  protected override readonly joinsStreams = true
  private sdk: DaytonaSdk | null = null
  private client: Daytona | null = null
  private sandbox: Sandbox | null = null

  constructor(name: string, config?: DaytonaConfig) {
    super(name, config, DaytonaMachine.configFields)
    requireId('daytona', 'sandboxId', this.config.sandboxId)
    checkOnPause('daytona', this.config.onPause, ON_PAUSE)
  }

  /** The sandbox's id at Daytona. */
  override get instance(): string {
    return this.config.sandboxId
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<DaytonaSdk> {
    return loadOptionalPeer(() => import('@daytonaio/sdk'), {
      feature: "the 'daytona' runtime",
      packageName: '@daytonaio/sdk',
    })
  }

  private async newClient(): Promise<Daytona> {
    this.sdk ??= await this.loadSdk()
    return new this.sdk.Daytona(
      this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : undefined,
    )
  }

  async connect(): Promise<void> {
    this.client ??= await this.newClient()
    this.sandbox = await this.client.get(this.config.sandboxId)
    if (this.sandbox.state === PAUSED_STATE) await this.sandbox.start()
    this.reached = true
  }

  /** Whether the config says `onPause: 'pause'`. */
  override configAsksToPause(): boolean {
    return this.config.onPause === 'pause'
  }

  /**
   * Pause the sandbox, keeping its disk and memory, through a client of its
   * own: close released the workspace's. Daytona pauses only VM sandboxes,
   * and refuses any other. A sandbox already gone has nothing to pause.
   */
  protected override async pauseMachine(): Promise<void> {
    const client = await this.newClient()
    try {
      const sandbox = await client.get(this.config.sandboxId)
      await sandbox.pause()
    } catch (error) {
      if (this.sdk === null || !(error instanceof this.sdk.DaytonaNotFoundError)) throw error
      logger.debug?.(`${this.machine.toString()}: sandbox already gone, nothing to pause`)
    } finally {
      await client[Symbol.asyncDispose]()
    }
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
  ): Promise<RunResult> {
    if (this.sandbox === null) throw new Error('daytona sandbox not connected')
    if (stdin !== null && !(stdin instanceof Uint8Array && stdin.byteLength === 0))
      return this.inputRefused(errors)
    const command = encodeOutput(wrapLine(argv, env, cwd), true)
    const response = await this.sandbox.process.executeCommand(command)
    const answer = decodeOutput(response.result)
    if (answer.byteLength > 0) await output(answer)
    return { exitCode: response.exitCode }
  }

  /** Release the SDK client once a connect under way has settled; the machine itself is the user's. */
  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      this.sandbox = null
      if (this.client !== null) {
        await this.client[Symbol.asyncDispose]()
        this.client = null
      }
    }
  }
}

registerMachine('daytona', DaytonaMachine)
