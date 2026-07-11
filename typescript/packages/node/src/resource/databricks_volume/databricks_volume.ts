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
  BaseResource,
  DATABRICKS_VOLUME_COMMANDS,
  DATABRICKS_VOLUME_OPS,
  DATABRICKS_VOLUME_PROMPT,
  DatabricksVolumeAccessor,
  PathSpec,
  ResourceName,
  databricksVolumeCopy,
  databricksVolumeCreate,
  databricksVolumeExists,
  databricksVolumeFind,
  databricksVolumeMkdir,
  databricksVolumeRangeRead,
  databricksVolumeRead,
  databricksVolumeReadStream,
  databricksVolumeReaddir,
  databricksVolumeRename,
  databricksVolumeRmRecursive,
  databricksVolumeRmdir,
  databricksVolumeStat,
  databricksVolumeUnlink,
  databricksVolumeWrite,
  mountKey,
  mountPrefixOf,
  resolveDatabricksVolumeGlob,
  type FileStat,
  type FindOptions,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import {
  redactDatabricksVolumeConfig,
  type DatabricksVolumeConfig,
  type DatabricksVolumeConfigRedacted,
} from './config.ts'
import { loadDatabricksProfile } from './profile.ts'

export interface DatabricksVolumeResourceState {
  type: string
  config: DatabricksVolumeConfigRedacted
}

async function resolveAuth(config: DatabricksVolumeConfig): Promise<[string, string]> {
  let host = config.host ?? process.env.DATABRICKS_HOST
  let token = config.token ?? process.env.DATABRICKS_TOKEN
  if (host === undefined || host === '' || token === undefined || token === '') {
    const profileName = config.profile ?? process.env.DATABRICKS_CONFIG_PROFILE ?? 'DEFAULT'
    const profile = await loadDatabricksProfile(profileName)
    host = host !== undefined && host !== '' ? host : profile.host
    token = token !== undefined && token !== '' ? token : profile.token
  }
  if (host === undefined || host === '' || token === undefined || token === '') {
    throw new Error(
      'databricks_volume: missing credentials; set host/token in the config, ' +
        'DATABRICKS_HOST/DATABRICKS_TOKEN env vars, or a ~/.databrickscfg profile',
    )
  }
  return [host, token]
}

export class DatabricksVolumeResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.DATABRICKS_VOLUME
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = DATABRICKS_VOLUME_PROMPT
  readonly config: DatabricksVolumeConfig
  readonly accessor: DatabricksVolumeAccessor
  readonly opsMap: Record<string, unknown> = {
    read_bytes: databricksVolumeRead,
    write: databricksVolumeWrite,
    readdir: databricksVolumeReaddir,
    stat: databricksVolumeStat,
    read_stream: databricksVolumeReadStream,
    range_read: databricksVolumeRangeRead,
    exists: databricksVolumeExists,
    create: databricksVolumeCreate,
    unlink: databricksVolumeUnlink,
    mkdir: databricksVolumeMkdir,
    rmdir: databricksVolumeRmdir,
    copy: databricksVolumeCopy,
    rename: databricksVolumeRename,
    rm_recursive: databricksVolumeRmRecursive,
  }

  private constructor(config: DatabricksVolumeConfig, accessor: DatabricksVolumeAccessor) {
    super()
    this.config = config
    this.accessor = accessor
  }

  static async create(config: DatabricksVolumeConfig): Promise<DatabricksVolumeResource> {
    const [host, token] = await resolveAuth(config)
    const accessor = new DatabricksVolumeAccessor(config, host, token)
    return new DatabricksVolumeResource(config, accessor)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return DATABRICKS_VOLUME_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return DATABRICKS_VOLUME_OPS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return databricksVolumeReadStream(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return databricksVolumeRead(this.accessor, p)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return databricksVolumeWrite(this.accessor, p, data)
  }

  async appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    let existing: Uint8Array
    try {
      existing = await databricksVolumeRead(this.accessor, p)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') {
        existing = new Uint8Array()
      } else {
        throw err
      }
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength)
    merged.set(existing, 0)
    merged.set(data, existing.byteLength)
    await databricksVolumeWrite(this.accessor, p, merged)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return databricksVolumeReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return databricksVolumeStat(this.accessor, p)
  }

  exists(p: PathSpec): Promise<boolean> {
    return databricksVolumeExists(this.accessor, p)
  }

  mkdir(p: PathSpec): Promise<void> {
    return databricksVolumeMkdir(this.accessor, p, undefined, true)
  }

  rmdir(p: PathSpec): Promise<void> {
    return databricksVolumeRmdir(this.accessor, p)
  }

  unlink(p: PathSpec): Promise<void> {
    return databricksVolumeUnlink(this.accessor, p)
  }

  rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return databricksVolumeRename(this.accessor, src, dst)
  }

  copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return databricksVolumeCopy(this.accessor, src, dst)
  }

  async rmR(p: PathSpec): Promise<void> {
    await databricksVolumeRmRecursive(this.accessor, p)
  }

  find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return databricksVolumeFind(this.accessor, p, options, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.resourcePath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                resourcePath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return resolveDatabricksVolumeGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<DatabricksVolumeResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactDatabricksVolumeConfig(this.config),
    })
  }

  loadState(_state: DatabricksVolumeResourceState): Promise<void> {
    return Promise.resolve()
  }
}
