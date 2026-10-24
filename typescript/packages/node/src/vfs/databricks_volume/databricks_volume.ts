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

import { DatabricksVolumeVFSBase } from '@struktoai/mirage-core/vfs/databricks_volume/databricks_volume'
import { DatabricksVolumeAccessor } from '@struktoai/mirage-core/accessor/databricks_volume'

import { PROMPT } from '@struktoai/mirage-core/vfs/databricks_volume/prompt'
import { VFSName } from '@struktoai/mirage-core/types'

import {
  redactDatabricksVolumeConfig,
  type DatabricksVolumeConfig,
  type DatabricksVolumeConfigRedacted,
} from './config.ts'
import { WALK_LIMIT } from '@struktoai/mirage-core/vfs/constants'

export interface DatabricksVolumeVFSState {
  type: string
  config: DatabricksVolumeConfigRedacted
}

export class DatabricksVolumeVFS extends DatabricksVolumeVFSBase {
  override readonly name: string = VFSName.DATABRICKS_VOLUME
  override readonly cachesReads: boolean = true
  // The Files API lists DirectoryEntry.file_size and stat HEADs report
  // Content-Length, both the exact byte count the download returns;
  // readdir backfills any lister-omitted size with one HEAD.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly prompt: string = PROMPT
  readonly config: DatabricksVolumeConfig
  override readonly accessor: DatabricksVolumeAccessor

  override readonly walkLimit: number
  private constructor(config: DatabricksVolumeConfig, accessor: DatabricksVolumeAccessor) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    this.accessor = accessor
  }

  static create(config: DatabricksVolumeConfig): Promise<DatabricksVolumeVFS> {
    const accessor = new DatabricksVolumeAccessor(config)
    return Promise.resolve(new DatabricksVolumeVFS(config, accessor))
  }

  override getState(): Promise<DatabricksVolumeVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactDatabricksVolumeConfig(this.config),
    })
  }
}
