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

const STDIN_PATH = '/tmp/.mirage_stdin'

const ENC = new TextEncoder()

export const DAYTONA_OPTION_KEYS: readonly string[] = [
  'captures',
  'apiKey',
  'image',
  'env',
  'resources',
  'sandboxId',
  'workspaceRoot',
  'script',
  'autoStopInterval',
  'autoDeleteInterval',
  'snapshot',
  'sandboxParams',
  'mount',
]

/** DaytonaRuntime options: the uniform surface plus Daytona lifecycle. */
export interface DaytonaRuntimeOptions extends RemoteSandboxOptions {
  /**
   * Name of a prebaked Daytona snapshot to boot from. Prefer this
   * over image for anything heavy: image builds run in the
   * sandbox-create path (slow, and large exports have wedged the
   * SDK's log stream), while a snapshot boots in seconds. Mutually
   * exclusive with image.
   */
  snapshot?: string
  /**
   * Minutes of inactivity before Daytona stops the sandbox (0 =
   * never; Daytona defaults to 15). A stopped sandbox keeps its disk
   * and can be reattached via sandboxId.
   */
  autoStopInterval?: number
  /**
   * Minutes after stopping before Daytona deletes the sandbox (0 =
   * on stop; Daytona defaults to never). GPU sandboxes are ephemeral
   * and always delete on stop.
   */
  autoDeleteInterval?: number
  /**
   * Extra Daytona create params passed through to the SDK, merged
   * last so they can also override anything computed here. Covers the
   * long tail (autoArchiveInterval, labels, volumes, ...) without a
   * named option per key. Keys are camelized, so yaml snake_case and
   * SDK camelCase both work.
   */
  sandboxParams?: Record<string, unknown>
}

/**
 * A Daytona sandbox as a whole-line runtime.
 *
 * The uniform RemoteSandbox surface maps directly: `image` becomes a
 * Daytona image sandbox (omitted = the account's default snapshot),
 * `resources` maps onto Daytona's per-sandbox sizing (`gpu` as a
 * number is a count, as a string a GPU type like "H100"; either
 * requests a GPU and forces the sandbox ephemeral, as Daytona
 * requires), `apiKey` falls back to DAYTONA_API_KEY. Daytona's exec
 * has no stdin and reports combined output, so piped bytes are
 * uploaded and redirected in, and stderr comes back null.
 */
export class DaytonaRuntime extends RemoteSandbox {
  readonly name = 'daytona'
  readonly snapshot: string | undefined
  readonly autoStopInterval: number | undefined
  readonly autoDeleteInterval: number | undefined
  readonly sandboxParams: Record<string, unknown>
  private client: Daytona | null = null
  private sandbox: Sandbox | null = null

  constructor(options: DaytonaRuntimeOptions | Record<string, unknown> = {}) {
    const { snapshot, autoStopInterval, autoDeleteInterval, sandboxParams, ...rest } =
      options as DaytonaRuntimeOptions
    super(rest)
    if (snapshot !== undefined && this.image !== undefined) {
      throw new Error(
        'daytona takes image or snapshot, not both: an image builds at ' +
          'create time, a snapshot is already built',
      )
    }
    this.snapshot = snapshot
    this.autoStopInterval = autoStopInterval
    this.autoDeleteInterval = autoDeleteInterval
    // Config-borne dicts keep yaml snake_case inner keys; the SDK
    // wants camelCase. Camelizing here makes both spellings work.
    this.sandboxParams = normalizeFields(sandboxParams ?? {})
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

  /** Map the uniform constructor fields onto Daytona params. */
  private createParams(): CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams {
    const shared: CreateSandboxFromSnapshotParams = {}
    if (Object.keys(this.env).length > 0) shared.envVars = { ...this.env }
    if (this.autoStopInterval !== undefined) shared.autoStopInterval = this.autoStopInterval
    if (this.autoDeleteInterval !== undefined) shared.autoDeleteInterval = this.autoDeleteInterval
    const resources = this.createResources()
    if (this.image === undefined) {
      // Snapshot sandboxes fix sizing when the snapshot is created;
      // dropping a resources block silently would hide that no GPU
      // was ever requested.
      if (resources !== null) {
        throw new Error(
          'daytona resources (cpu/memory/disk/gpu) require an image; a ' +
            'snapshot sandbox fixes its sizing when the snapshot is created',
        )
      }
      if (this.snapshot !== undefined) shared.snapshot = this.snapshot
      return { ...shared, ...this.sandboxParams } as CreateSandboxFromSnapshotParams
    }
    if (this.resources?.gpu !== undefined && this.resources.gpu !== 0) {
      shared.ephemeral = true
    }
    const params: CreateSandboxFromImageParams = { ...shared, image: this.image }
    if (resources !== null) params.resources = resources
    return { ...params, ...this.sandboxParams } as CreateSandboxFromImageParams
  }

  private createResources(): Resources | null {
    if (this.resources === undefined) return null
    const { cpu, memory, disk, gpu } = this.resources
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
