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
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Daytona,
  GpuType,
  Resources,
  Sandbox,
} from '@daytonaio/sdk'
import type * as daytonaSdk from '@daytonaio/sdk'

export type DaytonaSdk = typeof daytonaSdk

const ENC = new TextEncoder()

export const DAYTONA_OPTION_KEYS: readonly string[] = [
  'captures',
  'apiKey',
  'config',
  'sandboxId',
  'workspaceRoot',
  'script',
  'mount',
]

/**
 * A Daytona sandbox as a whole-line runtime.
 *
 * The general SandboxConfig maps directly: `image` becomes a Daytona
 * image sandbox built at create time, `template` names a prebaked
 * Daytona snapshot (prefer it for anything heavy: an inline image
 * build sits in the create path, a snapshot boots in seconds), sizing
 * maps onto Daytona's per-sandbox resources (`gpu` as a number is a
 * count, as a string a GPU type like "H100"; either requests a GPU
 * and forces the sandbox ephemeral, as Daytona requires), and
 * `params` passes any other Daytona create option verbatim
 * (autoStopInterval, autoDeleteInterval, labels, volumes, ...),
 * merged last so it can override anything computed here. `apiKey`
 * falls back to DAYTONA_API_KEY. Daytona's exec has no stdin and
 * reports combined output, so piped bytes are uploaded and redirected
 * in, and stderr comes back null.
 */
export class DaytonaRuntime extends RemoteSandbox {
  readonly name = 'daytona'
  // Config-borne dicts keep yaml snake_case inner keys; the SDK
  // wants camelCase. Camelizing here makes both spellings work.
  private readonly params: Record<string, unknown>
  private client: Daytona | null = null
  private sandbox: Sandbox | null = null

  constructor(options: RemoteSandboxOptions | Record<string, unknown> = {}) {
    super(options)
    if (this.config.image !== undefined && this.config.template !== undefined) {
      throw new Error(
        'daytona takes image or template, not both: an image builds at ' +
          'create time, a template names a snapshot that is already built',
      )
    }
    if (this.config.args.length > 0) {
      throw new Error(
        'daytona is SDK-driven and takes no CLI args; pass create ' +
          'options through config params instead',
      )
    }
    this.params = normalizeFields(this.config.params)
  }

  // The SDK loader as a seam: tests substitute a fake module here.
  protected loadSdk(): Promise<DaytonaSdk> {
    return loadOptionalPeer(() => import('@daytonaio/sdk'), {
      feature: "the 'daytona' runtime",
      packageName: '@daytonaio/sdk',
    })
  }

  private async ensureClient(): Promise<Daytona> {
    if (this.client === null) {
      const sdk = await this.loadSdk()
      this.client = new sdk.Daytona(this.apiKey !== undefined ? { apiKey: this.apiKey } : undefined)
    }
    return this.client
  }

  async createSandbox(): Promise<string> {
    const client = await this.ensureClient()
    const params = this.createParams()
    // The SDK's create() overloads take image and snapshot params
    // separately; the `in` check narrows the union to one of them.
    this.sandbox = 'image' in params ? await client.create(params) : await client.create(params)
    return this.sandbox.id
  }

  async connectSandbox(sandboxId: string): Promise<void> {
    const client = await this.ensureClient()
    this.sandbox = await client.get(sandboxId)
  }

  /**
   * $HOME/workspace: the sandbox user is not root (uid 1001 `daytona`
   * in the default snapshot), so a root-level /workspace cannot even
   * be created; home always can.
   */
  override async defaultWorkspaceRoot(): Promise<string> {
    if (this.sandbox === null) throw new Error('daytona sandbox not started')
    const response = await this.sandbox.process.executeCommand('printf "%s" "$HOME"')
    const home = rstripSlash(response.result.trim())
    return `${home}/workspace`
  }

  /** Map the general config onto Daytona create params. */
  private createParams(): CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams {
    const shared: CreateSandboxFromSnapshotParams = {}
    if (Object.keys(this.config.env).length > 0) shared.envVars = { ...this.config.env }
    const resources = this.createResources()
    if (this.config.image === undefined) {
      // Snapshot sandboxes fix sizing when the snapshot is created;
      // dropping sizing silently would hide that no GPU was ever
      // requested.
      if (resources !== null) {
        throw new Error(
          'daytona sizing (cpu/memory/disk/gpu) requires an image; a ' +
            'snapshot sandbox fixes its sizing when the snapshot is created',
        )
      }
      if (this.config.template !== undefined) shared.snapshot = this.config.template
      return { ...shared, ...this.params } as CreateSandboxFromSnapshotParams
    }
    if (this.config.gpu !== undefined && this.config.gpu !== 0) {
      shared.ephemeral = true
    }
    const params: CreateSandboxFromImageParams = { ...shared, image: this.config.image }
    if (resources !== null) params.resources = resources
    return { ...params, ...this.params } as CreateSandboxFromImageParams
  }

  private createResources(): Resources | null {
    if (!sizedConfig(this.config)) return null
    const { cpu, memory, disk, gpu } = this.config
    const mapped: Resources = {}
    if (cpu !== undefined) mapped.cpu = cpu
    if (memory !== undefined) mapped.memory = memory
    if (disk !== undefined) mapped.disk = disk
    if (typeof gpu === 'number') {
      mapped.gpu = gpu
    } else if (gpu !== undefined) {
      mapped.gpu = 1
      mapped.gpuType = gpu as GpuType
    }
    return mapped
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    if (this.sandbox === null) throw new Error('daytona sandbox not started')
    let command = line
    if (stdin !== null) {
      await this.upload(STDIN_PATH, stdin)
      command = `( ${line} ) < ${STDIN_PATH}`
    }
    const response = await this.sandbox.process.executeCommand(command, cwd, env)
    return {
      stdout: ENC.encode(response.result),
      stderr: null,
      exitCode: response.exitCode,
    }
  }

  async upload(path: string, data: Uint8Array): Promise<void> {
    if (this.sandbox === null) throw new Error('daytona sandbox not started')
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : ''
    if (parent !== '') await this.sandbox.fs.createFolder(parent, '755')
    await this.sandbox.fs.uploadFile(Buffer.from(data), path)
  }

  async download(path: string): Promise<Uint8Array> {
    if (this.sandbox === null) throw new Error('daytona sandbox not started')
    const data = await this.sandbox.fs.downloadFile(path)
    return new Uint8Array(data)
  }

  async close(): Promise<void> {
    if (this.sandbox !== null && this.client !== null) {
      if (this.ownedSandbox) await this.client.delete(this.sandbox)
      this.sandbox = null
    }
    if (this.client !== null) {
      await this.client[Symbol.asyncDispose]()
      this.client = null
    }
  }
}

registerRuntime('daytona', DaytonaRuntime, DAYTONA_OPTION_KEYS)
