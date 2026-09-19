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

import { GDriveAccessor } from '@struktoai/mirage-core/accessor/gdrive'
import { GDRIVE_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gdrive/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { buildDeltaHook } from '@struktoai/mirage-core/core/gdrive/watch'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GDRIVE_OPS } from '@struktoai/mirage-core/ops/gdrive/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GDRIVE_PROMPT } from '@struktoai/mirage-core/vfs/gdrive/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import {
  redactGDriveConfig,
  type GDriveConfig,
  type GDriveConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdrive/config'
export interface GDriveVFSState {
  type: string
  config: GDriveConfigRedacted
}

export class GDriveVFS extends BaseVFS {
  override readonly name: string = VFSName.GDRIVE
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = GDRIVE_PROMPT
  readonly config: GDriveConfig
  override readonly accessor: GDriveAccessor

  constructor(config: GDriveConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDriveAccessor({ tokenManager: tm })
  }
  override commands(): readonly RegisteredCommand[] {
    return GDRIVE_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GDRIVE_OPS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GDriveVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGDriveConfig(this.config),
    })
  }

  override loadState(_state: GDriveVFSState): Promise<void> {
    return Promise.resolve()
  }
}
