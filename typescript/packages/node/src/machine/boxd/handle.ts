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

import { closeQuietly, feed } from '@struktoai/mirage-core/io/stream'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { YieldBudget } from '@struktoai/mirage-core/io/yield_budget'
import { currentCaller } from '@struktoai/mirage-core/context/session_context'
import { requireId } from '@struktoai/mirage-core/machine/config'
import {
  isRun,
  notRunningHint,
  PROCESS,
  runTag,
  stopSignal,
  wrapLine,
} from '@struktoai/mirage-core/machine/constants'
import { ConnectionLostError } from '@struktoai/mirage-core/machine/errors'
import { MachineHandle } from '@struktoai/mirage-core/machine/handle'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import { abortable } from '@struktoai/mirage-core/utils/abort'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import type { Boxd, ExecStream } from '@boxd-sh/sdk'
import { BOXD_CONFIG_FIELDS, type BoxdConfig } from './config.ts'
import { MACHINE_GONE } from './constants.ts'
import { loadSdk, type BoxdSdk } from './sdk.ts'

const ENC = new TextEncoder()

/** Every chunk of one of an exec stream's outputs, each handed to `sink`. */
async function drain(
  chunks: AsyncIterable<Uint8Array>,
  sink: (data: Uint8Array) => Promise<void> | void,
): Promise<void> {
  for await (const chunk of chunks) await sink(chunk)
}

/**
 * A boxd machine, reached through its SDK.
 *
 * You create the machine yourself (`boxd machine new`, the console or the
 * SDK); mirage only connects by `machineId` and execs lines. `apiKey` falls
 * back to BOXD_API_KEY and `region` to BOXD_REGION. Each line is one
 * streamed exec: stdin is sent as it is read and then closed, and stdout
 * and stderr come back separately, byte for byte, as the program writes
 * them. No input closes stdin when the command starts. Ending the stream
 * ends the command's process group. It takes no `mountType`: put the files
 * the programs need on the machine yourself.
 *
 * The machine is yours: Mirage never starts, stops or deletes it. A machine
 * in standby or hibernated wakes on the first line. Once boxd says it is
 * gone or stopped, connecting fails with what to do, and a line it cut short
 * loses its connection (129) with the same advice; the next line connects
 * again. close() releases the SDK client.
 */
export class BoxdMachine extends MachineHandle<BoxdConfig> {
  static override readonly configFields: ConfigFields = BOXD_CONFIG_FIELDS
  static override readonly provider = 'boxd'
  private sdk: BoxdSdk | null = null
  private client: Boxd | null = null

  constructor(name: string, config?: BoxdConfig) {
    super(name, config, BoxdMachine.configFields)
    requireId('boxd', 'machineId', this.config.machineId)
  }

  /** The machine's id at boxd. */
  override get instance(): string {
    return this.config.machineId
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<BoxdSdk> {
    return loadSdk()
  }

  async connect(): Promise<void> {
    const sdk = (this.sdk ??= await this.loadSdk())
    this.client ??= new sdk.Boxd({
      ...(this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}),
      ...(this.config.region !== undefined ? { region: this.config.region } : {}),
    })
    let state: string
    try {
      state = (await this.client.machines.get(this.config.machineId)).status
    } catch (error) {
      const hint = this.gone(sdk, error)
      throw hint === null ? error : new Error(hint, { cause: error })
    }
    if (MACHINE_GONE[state] !== undefined)
      throw new Error(notRunningHint('machine', this.config.machineId, state, MACHINE_GONE))
  }

  /** What to do when `error` says the machine is gone, else null. */
  private gone(sdk: BoxdSdk, error: unknown): string | null {
    return error instanceof sdk.NotFoundError
      ? notRunningHint('machine', this.config.machineId, 'deleted', MACHINE_GONE)
      : null
  }

  /**
   * The lost connection `error` is when the machine went or boxd could not
   * be reached, which also lets the next line connect again; null otherwise.
   * `stdout` and `stderr` are what the line kept before the drop.
   */
  private lost(
    sdk: BoxdSdk,
    error: unknown,
    stdout: Uint8Array,
    stderr: Uint8Array,
  ): ConnectionLostError | null {
    let hint = this.gone(sdk, error)
    if (
      hint === null &&
      (error instanceof sdk.APIConnectionError || error instanceof sdk.ConflictError)
    )
      hint = error.message
    if (hint === null) return null
    this.disconnected()
    return new ConnectionLostError(hint, stdout, concat([stderr, ENC.encode(`boxd: ${hint}\n`)]))
  }

  private stream(command: string, closeStdin: boolean): ExecStream {
    if (this.client === null) throw new Error('boxd machine not connected')
    return this.client.machines.streamExec(this.config.machineId, { command, closeStdin })
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted()
    const sdk = this.sdk
    if (sdk === null) throw new Error('boxd machine not connected')
    const runner = currentCaller().process
    const stream = this.stream(wrapLine(argv, env, cwd), stdin === null)
    const out: Uint8Array[] = []
    const err: Uint8Array[] = []
    const state = { exited: false }
    const budget = new YieldBudget()
    // The command may end without reading all its input (head), so its
    // exit, not the end of the input, ends the line. The SDK queues input
    // without waiting, so an input that is always ready would never let
    // the output or an abort in: the budget gives them their turn.
    const feeding =
      stdin === null
        ? Promise.resolve()
        : feed(
            stdin,
            async (chunk) => {
              if (state.exited) return
              stream.write(chunk)
              await budget.run()
            },
            () => {
              stream.end()
              return Promise.resolve()
            },
            () => state.exited,
          )
    // An input that fails as it is read ends the line too.
    const failedInput = feeding.then(() => new Promise<never>(() => undefined))
    let exitCode: number
    try {
      const [, , code] = await abortable(
        Promise.race([
          Promise.all([
            drain(stream.stdout, (data) => (output === null ? void out.push(data) : output(data))),
            drain(stream.stderr, (data) => (errors === null ? void err.push(data) : errors(data))),
            stream.wait(),
          ]),
          failedInput,
        ]),
        signal,
      )
      exitCode = code
      state.exited = true
      feeding.catch((error: unknown) => {
        console.debug(`boxd input after the command ended: ${String(error)}`)
      })
      // The input may still wait on a source that stays open: closing it
      // lets its writer go, and is not waited for behind that read.
      void closeQuietly(stdin)
      stream.close()
    } catch (error) {
      state.exited = true
      void closeQuietly(stdin)
      const lost = signal?.aborted === true ? null : this.lost(sdk, error, concat(out), concat(err))
      if (lost !== null) {
        stream.close()
        throw lost
      }
      // Ending the stream ends the command with TERM; a run a kill stopped
      // with a gentler signal gets that signal first.
      const tag = isRun(argv) ? runTag(argv) : env[PROCESS]
      const signum = stopSignal(runner)
      if (tag !== undefined && signum !== null) await this.stop(tag, signum)
      stream.close()
      if (signal?.aborted) throw new DOMException('execute aborted', 'AbortError')
      if (tag !== undefined) await this.stop(tag, 15)
      throw error
    }
    return {
      stdout: output === null ? concat(out) : new Uint8Array(),
      stderr: errors === null ? concat(err) : new Uint8Array(),
      exitCode,
    }
  }

  /** Release the SDK client; the machine itself is the user's. */
  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      const client = this.client
      this.client = null
      await client?.close()
    }
  }
}

registerMachine('boxd', BoxdMachine)
