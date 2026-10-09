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

import { RemoteSandbox } from '../base.ts'
import { registerRuntime } from '../../table.ts'
import type { RunResult } from '../../types.ts'
import type { RuntimeOptions } from '../../config.ts'
import { loadSdk, type E2bSdk } from './sdk.ts'
import { E2B_CONFIG_KEYS, type E2BConfig } from './config.ts'
import type { CommandResult, Sandbox } from 'e2b'

const ENC = new TextEncoder()

/**
 * An E2B sandbox the user runs as a whole-line runtime.
 *
 * You create the sandbox yourself (`e2b sandbox spawn` or the SDK);
 * mirage only connects by `sandboxId` and execs lines. `apiKey` falls
 * back to E2B_API_KEY. E2B's exec reports stdout and stderr
 * separately. Piped bytes use native stdin followed by an explicit
 * EOF; no input closes stdin when the command starts.
 */
export class E2BRuntime extends RemoteSandbox<E2BConfig> {
  readonly name = 'e2b'
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RuntimeOptions<E2BConfig> | Record<string, unknown> = {}) {
    super(options, E2B_CONFIG_KEYS)
    if (typeof this.config.sandboxId !== 'string' || !this.config.sandboxId.trim()) {
      throw new Error('e2b config needs a nonblank sandboxId')
    }
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<E2bSdk> {
    return loadSdk()
  }

  private async ensureSdk(): Promise<E2bSdk> {
    this.sdk ??= await this.loadSdk()
    return this.sdk
  }

  private apiParams(): Record<string, unknown> {
    return this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : {}
  }

  async connect(): Promise<void> {
    const sdk = await this.ensureSdk()
    this.sandbox = await sdk.Sandbox.connect(this.config.sandboxId, this.apiParams())
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    signal?.throwIfAborted()
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const sdk = await this.ensureSdk()
    signal?.throwIfAborted()
    // Keep the startup result even if aborted in flight, so its process can be killed.
    const handle = await this.sandbox.commands.run(line, {
      envs: env,
      cwd,
      background: true,
      stdin: stdin !== null,
    })
    let result: Pick<CommandResult, 'stdout' | 'stderr' | 'exitCode'>
    try {
      signal?.throwIfAborted()
      try {
        if (stdin !== null) {
          if (stdin.byteLength > 0) await this.waitFor(handle.sendStdin(stdin), signal)
          await this.waitFor(handle.closeStdin(), signal)
        }
      } catch (error) {
        // The command may exit before the input RPC arrives. Wait for its
        // real exit status rather than reporting the missing process as I/O.
        // Process RPCs still throw this SDK class; no process-specific replacement exists.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        if (!(error instanceof sdk.NotFoundError)) throw error
      }
      result = await this.waitFor(handle.wait(), signal)
      signal?.throwIfAborted()
    } catch (error) {
      if (!signal?.aborted && error instanceof sdk.CommandExitError) {
        result = error
      } else {
        try {
          await handle.kill()
        } catch (cleanupError) {
          console.warn('Failed to stop the E2B command', cleanupError)
        }
        if (signal?.aborted) throw new DOMException('execute aborted', 'AbortError')
        throw error
      }
    } finally {
      await handle.disconnect()
    }
    return {
      stdout: ENC.encode(result.stdout),
      stderr: ENC.encode(result.stderr),
      exitCode: result.exitCode,
    }
  }
}

registerRuntime('e2b', E2BRuntime)
