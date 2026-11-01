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
import { VFSName } from '@struktoai/mirage-core/types'
import { DatabricksVolumeVFS as CoreDatabricksVolumeVFS } from '@struktoai/mirage-core/vfs/databricks_volume/databricks_volume'
import type { RedactedSchema } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigState } from '@struktoai/mirage-core/vfs/types'
import { DatabricksVolumeConfig } from './config.ts'

export class DatabricksVolumeVFS extends CoreDatabricksVolumeVFS {
  override readonly name: string = VFSName.DATABRICKS_VOLUME
  override readonly cachesReads: boolean = true
  // The Files API lists DirectoryEntry.file_size and stat HEADs report
  // Content-Length, both the exact byte count the download returns;
  // readdir backfills any lister-omitted size with one HEAD.
  override readonly sizesAlwaysKnown: boolean = true
  readonly config: DatabricksVolumeConfig
  override readonly accessor: DatabricksVolumeAccessor

  private constructor(config: DatabricksVolumeConfig, accessor: DatabricksVolumeAccessor) {
    super()
    this.config = config
    this.accessor = accessor
  }

  static create(config: DatabricksVolumeConfig): Promise<DatabricksVolumeVFS> {
    const accessor = new DatabricksVolumeAccessor(config)
    return Promise.resolve(new DatabricksVolumeVFS(config, accessor))
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof DatabricksVolumeConfig>>> {
    return Promise.resolve(this.configState(DatabricksVolumeConfig, this.config))
  }
}
