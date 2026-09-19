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

import { GCalAccessor } from '@struktoai/mirage-core/accessor/gcal'
import { GCAL_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gcal/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GCAL_OPS } from '@struktoai/mirage-core/ops/gcal/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GCAL_PROMPT, GCAL_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gcal/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import {
  redactGCalConfig,
  type GCalConfig,
  type GCalConfigRedacted,
} from '@struktoai/mirage-core/vfs/gcal/config'
export interface GCalVFSState {
  type: string
  config: GCalConfigRedacted
}

export class GCalVFS extends BaseVFS {
  override readonly name: string = VFSName.GCAL
  override readonly cachesReads: boolean = true
  // Shorter than the other Google mounts: a calendar is edited by other
  // people and a day-long index would keep serving a schedule that has
  // already moved.
  override readonly indexTtl: number = 300
  override readonly prompt: string = GCAL_PROMPT
  override readonly writePrompt: string = GCAL_WRITE_PROMPT
  readonly config: GCalConfig
  override readonly accessor: GCalAccessor

  constructor(config: GCalConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GCalAccessor({ tokenManager: tm, config })
  }
  override commands(): readonly RegisteredCommand[] {
    return GCAL_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GCAL_OPS
  }
  override getState(): Promise<GCalVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGCalConfig(this.config),
    })
  }

  override loadState(_state: GCalVFSState): Promise<void> {
    return Promise.resolve()
  }
}
