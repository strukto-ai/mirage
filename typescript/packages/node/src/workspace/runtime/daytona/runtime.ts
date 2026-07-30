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
import { DAYTONA_CONFIG_KEYS, type DaytonaConfig } from './config.ts'
import type { Daytona, Sandbox } from '@daytonaio/sdk'
import type * as daytonaSdk from '@daytonaio/sdk'

export type DaytonaSdk = typeof daytonaSdk

const ENC = new TextEncoder()

/**
 * A Daytona sandbox the user runs as a whole-line runtime.
 *
 * You create the sandbox yourself (dashboard, `daytona sandbox
 * create`, or the SDK); mirage only connects by `sandboxId` and execs
 * lines. `apiKey` falls back to DAYTONA_API_KEY. Daytona's exec has
 * no stdin and reports combined output, so piped bytes are uploaded
 * and redirected in, and stderr comes back null. close() releases the
 * SDK client and never touches the sandbox.
 */
export class DaytonaRuntime extends RemoteSandbox<DaytonaConfig> {
  readonly name = 'daytona'
  private client: Daytona | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RuntimeOptions<DaytonaConfig> | Record<string, unknown> = {}) {
    super(options, DAYTONA_CONFIG_KEYS)
    if (!this.config.sandboxId) {
      throw new Error('daytona config needs sandboxId: the id of a live sandbox you created')
    }
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<DaytonaSdk> {
    return loadOptionalPeer(() => import('@daytonaio/sdk'), {
      feature: "the 'daytona' runtime",
      packageName: '@daytonaio/sdk',
    })
  }

  async connect(): Promise<void> {
    if (this.client === null) {
      const sdk = await this.loadSdk()
      this.client = new sdk.Daytona(
        this.config.apiKey !== undefined ? { apiKey: this.config.apiKey } : undefined,
      )
    }
    this.sandbox = await this.client.get(this.config.sandboxId)
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    if (this.sandbox === null) throw new Error('daytona sandbox not connected')
    let command = line
    if (stdin !== null) {
      const path = stdinPath()
      await this.upload(path, stdin)
      command = stdinRedirect(line, path)
    }
    const response = await this.sandbox.process.executeCommand(command, cwd, env)
    return {
      stdout: ENC.encode(response.result),
      stderr: null,
      exitCode: response.exitCode,
    }
  }

  private async upload(path: string, data: Uint8Array): Promise<void> {
    if (this.sandbox === null) throw new Error('daytona sandbox not connected')
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : ''
    if (parent !== '') await this.sandbox.fs.createFolder(parent, '755')
    await this.sandbox.fs.uploadFile(Buffer.from(data), path)
  }

  /** Release the SDK client; the sandbox itself is the user's. */
  override async close(): Promise<void> {
    this.sandbox = null
    if (this.client !== null) {
      await this.client[Symbol.asyncDispose]()
      this.client = null
    }
  }
}

registerRuntime('daytona', DaytonaRuntime)
