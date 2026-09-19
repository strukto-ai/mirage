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

import { GSlidesAccessor } from '@struktoai/mirage-core/accessor/gslides'
import { GSLIDES_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gslides/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GSLIDES_OPS } from '@struktoai/mirage-core/ops/gslides/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GSLIDES_PROMPT, GSLIDES_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gslides/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import {
  redactGSlidesConfig,
  type GSlidesConfig,
  type GSlidesConfigRedacted,
} from '@struktoai/mirage-core/vfs/gslides/config'
export interface GSlidesVFSState {
  type: string
  config: GSlidesConfigRedacted
}

export class GSlidesVFS extends BaseVFS {
  override readonly name: string = VFSName.GSLIDES
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = GSLIDES_PROMPT
  override readonly writePrompt: string = GSLIDES_WRITE_PROMPT
  readonly config: GSlidesConfig
  override readonly accessor: GSlidesAccessor

  constructor(config: GSlidesConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSlidesAccessor({ tokenManager: tm })
  }
  override commands(): readonly RegisteredCommand[] {
    return GSLIDES_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GSLIDES_OPS
  }
  override getState(): Promise<GSlidesVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGSlidesConfig(this.config),
    })
  }

  override loadState(_state: GSlidesVFSState): Promise<void> {
    return Promise.resolve()
  }
}
