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

import {
  loadOptionalPeer,
  registerRuntime,
  RemoteSandbox,
  type RuntimeOptions,
  type RunResult,
  stdinPath,
  stdinRedirect,
} from '@struktoai/mirage-core'
import { E2B_CONFIG_KEYS, type E2BConfig } from './config.ts'
import type { CommandResult, Sandbox } from 'e2b'
import type * as e2bSdk from 'e2b'

export type E2bSdk = typeof e2bSdk

const ENC = new TextEncoder()

/**
 * An E2B sandbox the user runs as a whole-line runtime.
 *
 * You create the sandbox yourself (`e2b sandbox spawn` or the SDK);
 * mirage only connects by `sandboxId` and execs lines. `apiKey` falls
 * back to E2B_API_KEY. E2B's exec reports stdout and stderr
 * separately, so both stream back real; it takes no stdin, so piped
 * bytes are uploaded and redirected in.
 */
export class E2BRuntime extends RemoteSandbox<E2BConfig> {
  readonly name = 'e2b'
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RuntimeOptions<E2BConfig> | Record<string, unknown> = {}) {
    super(options, E2B_CONFIG_KEYS)
    if (!this.config.sandboxId) {
      throw new Error('e2b config needs sandboxId: the id of a live sandbox you created')
    }
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<E2bSdk> {
    return loadOptionalPeer(() => import('e2b'), {
      feature: "the 'e2b' runtime",
      packageName: 'e2b',
    })
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
  ): Promise<RunResult> {
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const sdk = await this.ensureSdk()
    let command = line
    if (stdin !== null) {
      const path = stdinPath()
      await this.upload(path, stdin)
      command = stdinRedirect(line, path)
    }
    let result: Pick<CommandResult, 'stdout' | 'stderr' | 'exitCode'>
    try {
      result = await this.sandbox.commands.run(command, { envs: env, cwd })
    } catch (error) {
      if (!(error instanceof sdk.CommandExitError)) throw error
      result = error
    }
    return {
      stdout: ENC.encode(result.stdout),
      stderr: ENC.encode(result.stderr),
      exitCode: result.exitCode,
    }
  }

  private async upload(path: string, data: Uint8Array): Promise<void> {
    if (this.sandbox === null) throw new Error('e2b sandbox not connected')
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : ''
    if (parent !== '') await this.sandbox.files.makeDir(parent)
    await this.sandbox.files.write(path, new Blob([data]))
  }
}

registerRuntime('e2b', E2BRuntime)
