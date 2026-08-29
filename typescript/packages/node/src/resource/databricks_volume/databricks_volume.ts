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

import { DatabricksVolumeAccessor } from '@struktoai/mirage-core/accessor/databricks_volume'
import { DATABRICKS_VOLUME_COMMANDS } from '@struktoai/mirage-core/commands/builtin/databricks_volume/index'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { copy as databricksVolumeCopy } from '@struktoai/mirage-core/core/databricks_volume/copy'
import { create as databricksVolumeCreate } from '@struktoai/mirage-core/core/databricks_volume/create'
import { exists as databricksVolumeExists } from '@struktoai/mirage-core/core/databricks_volume/exists'
import { mkdir as databricksVolumeMkdir } from '@struktoai/mirage-core/core/databricks_volume/mkdir'
import { readBytes as databricksVolumeRead } from '@struktoai/mirage-core/core/databricks_volume/read'
import { readdir as databricksVolumeReaddir } from '@struktoai/mirage-core/core/databricks_volume/readdir'
import { rename as databricksVolumeRename } from '@struktoai/mirage-core/core/databricks_volume/rename'
import { rmRecursive as databricksVolumeRmRecursive } from '@struktoai/mirage-core/core/databricks_volume/rm'
import { rmdir as databricksVolumeRmdir } from '@struktoai/mirage-core/core/databricks_volume/rmdir'
import { stat as databricksVolumeStat } from '@struktoai/mirage-core/core/databricks_volume/stat'
import {
  rangeRead as databricksVolumeRangeRead,
  readStream as databricksVolumeReadStream,
} from '@struktoai/mirage-core/core/databricks_volume/stream'
import { unlink as databricksVolumeUnlink } from '@struktoai/mirage-core/core/databricks_volume/unlink'
import { writeBytes as databricksVolumeWrite } from '@struktoai/mirage-core/core/databricks_volume/write'
import { walkFind } from '@struktoai/mirage-core/core/generic/find'
import { DATABRICKS_VOLUME_OPS } from '@struktoai/mirage-core/ops/databricks_volume/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseResource } from '@struktoai/mirage-core/resource/base'
import type { FindOptions, Resource } from '@struktoai/mirage-core/resource/base'
import { DATABRICKS_VOLUME_PROMPT } from '@struktoai/mirage-core/resource/databricks_volume/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import {
  redactDatabricksVolumeConfig,
  type DatabricksVolumeConfig,
  type DatabricksVolumeConfigRedacted,
} from './config.ts'

const resolveDatabricksVolumeGlob = makeResolveGlob(databricksVolumeReaddir)

export interface DatabricksVolumeResourceState {
  type: string
  config: DatabricksVolumeConfigRedacted
}

export class DatabricksVolumeResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.DATABRICKS_VOLUME
  readonly cachesReads: boolean = true
  // The Files API lists DirectoryEntry.file_size and stat HEADs report
  // Content-Length, both the exact byte count the download returns;
  // readdir backfills any lister-omitted size with one HEAD.
  readonly sizesAlwaysKnown: boolean = true
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

  /**
   * Mount one Unity Catalog volume over the Files API.
   *
   * @param config workspace host, bearer token, volume coordinates and
   * transport.
   */
  constructor(config: DatabricksVolumeConfig) {
    super()
    this.config = config
    this.accessor = new DatabricksVolumeAccessor(config)
  }

  open(): Promise<void> {
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
    // Databricks readdir returns slash-less paths, so the walker classifies
    // through stat (which resolves via the index cache).
    return walkFind(
      p,
      {
        readdir: (spec, idx) => databricksVolumeReaddir(this.accessor, spec, idx),
        stat: (spec, idx) => databricksVolumeStat(this.accessor, spec, idx),
      },
      options,
      this.index,
    )
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

  override getState(): Promise<DatabricksVolumeResourceState> {
    // The token dumps as <REDACTED>, which is what makes both loaders demand
    // a fresh resource; no separate marker is needed.
    return Promise.resolve({
      type: this.kind,
      config: redactDatabricksVolumeConfig(this.config),
    })
  }

  override loadState(_state: DatabricksVolumeResourceState): Promise<void> {
    return Promise.resolve()
  }
}
