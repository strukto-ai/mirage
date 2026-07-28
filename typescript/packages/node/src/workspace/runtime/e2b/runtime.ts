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
  normalizeFields,
  registerRuntime,
  RemoteSandbox,
  type RemoteSandboxOptions,
  rstripSlash,
  type RunResult,
  sizedConfig,
  STDIN_PATH,
} from '@struktoai/mirage-core'
import type { CommandResult, Sandbox } from 'e2b'
import type * as e2bSdk from 'e2b'

export type E2bSdk = typeof e2bSdk

const ENC = new TextEncoder()

export const E2B_OPTION_KEYS: readonly string[] = [
  'captures',
  'apiKey',
  'config',
  'sandboxId',
  'workspaceRoot',
  'script',
  'mount',
]

/**
 * An E2B sandbox as a whole-line runtime.
 *
 * E2B has no inline image builds and no per-sandbox sizing: both are
 * baked into a named template (`e2b template build`), so `image` and
 * sizing fail loud, `template` selects the prebuilt environment
 * (E2B's default template when omitted), and `params` passes any
 * other Sandbox.create option verbatim (timeoutMs, metadata,
 * allowInternetAccess, ...), merged last so it can override anything
 * computed here. `apiKey` falls back to E2B_API_KEY. E2B's exec
 * reports stdout and stderr separately, so both stream back real.
 */
export class E2BRuntime extends RemoteSandbox {
  readonly name = 'e2b'
  // Config-borne dicts keep yaml snake_case inner keys; the SDK
  // wants camelCase. Camelizing here makes both spellings work.
  private readonly params: Record<string, unknown>
  private sdk: E2bSdk | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RemoteSandboxOptions | Record<string, unknown> = {}) {
    super(options)
    if (this.config.image !== undefined) {
      throw new Error(
        "e2b has no inline image builds: build a template with 'e2b template " +
          'build' +
          "' and pass template instead of image",
      )
    }
    if (sizedConfig(this.config)) {
      throw new Error(
        'e2b fixes sizing in the template, not per sandbox: bake cpu/memory ' +
          'into the template instead of sizing the config',
      )
    }
    if (this.config.args.length > 0) {
      throw new Error(
        'e2b is SDK-driven and takes no CLI args; pass create options ' +
          'through config params instead',
      )
    }
    this.params = normalizeFields(this.config.params)
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
    return this.apiKey !== undefined ? { apiKey: this.apiKey } : {}
  }

  async createSandbox(): Promise<string> {
    const sdk = await this.ensureSdk()
    const params: Record<string, unknown> = this.apiParams()
    if (this.config.template !== undefined) params.template = this.config.template
    if (Object.keys(this.config.env).length > 0) params.envs = { ...this.config.env }
    Object.assign(params, this.params)
    this.sandbox = await sdk.Sandbox.create(params)
    return this.sandbox.sandboxId
  }

  async connectSandbox(sandboxId: string): Promise<void> {
    const sdk = await this.ensureSdk()
    this.sandbox = await sdk.Sandbox.connect(sandboxId, this.apiParams())
  }

  /**
   * $HOME/workspace: the default template user is `user` (uid 1000),
   * so a root-level /workspace is not writable; home is.
   */
  override async defaultWorkspaceRoot(): Promise<string> {
    if (this.sandbox === null) throw new Error('e2b sandbox not started')
    const result = await this.sandbox.commands.run('printf "%s" "$HOME"')
    const home = rstripSlash(result.stdout.trim())
    return `${home}/workspace`
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    if (this.sandbox === null) throw new Error('e2b sandbox not started')
    const sdk = await this.ensureSdk()
    let command = line
    if (stdin !== null) {
      await this.upload(STDIN_PATH, stdin)
      command = `( ${line} ) < ${STDIN_PATH}`
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

  async upload(path: string, data: Uint8Array): Promise<void> {
    if (this.sandbox === null) throw new Error('e2b sandbox not started')
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : ''
    if (parent !== '') await this.sandbox.files.makeDir(parent)
    await this.sandbox.files.write(path, new Blob([data]))
  }

  async download(path: string): Promise<Uint8Array> {
    if (this.sandbox === null) throw new Error('e2b sandbox not started')
    return await this.sandbox.files.read(path, { format: 'bytes' })
  }

  async close(): Promise<void> {
    if (this.sandbox !== null) {
      if (this.ownedSandbox) await this.sandbox.kill()
      this.sandbox = null
    }
  }
}

registerRuntime('e2b', E2BRuntime, E2B_OPTION_KEYS)
