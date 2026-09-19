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

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { VFSName } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import { GRIDFS_COMMANDS } from '../../commands/builtin/gridfs/index.ts'
import { GRIDFS_OPS } from '../../ops/gridfs/index.ts'
import { redactConfig, type GridFSConfig, type GridFSConfigRedacted } from './config.ts'
import { GRIDFS_PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/gridfs/watch.ts'
export interface GridFSVFSState {
  type: string
  config: GridFSConfigRedacted
}

export class GridFSVFS extends BaseVFS {
  override readonly name: string = VFSName.GRIDFS
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  override readonly prompt: string = GRIDFS_PROMPT
  readonly config: GridFSConfig
  override readonly accessor: GridFSAccessor
  constructor(config: GridFSConfig) {
    super()
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: GridFSConfig = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    this.accessor = new GridFSAccessor(this.config)
  }
  override async close(): Promise<void> {
    await this.accessor.close()
    await super.close()
  }

  override commands(): readonly RegisteredCommand[] {
    return GRIDFS_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GRIDFS_OPS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GridFSVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactConfig(this.config),
    })
  }

  override loadState(_state: GridFSVFSState): Promise<void> {
    return Promise.resolve()
  }
}
