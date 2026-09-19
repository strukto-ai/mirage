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

import { GDocsAccessor } from '@struktoai/mirage-core/accessor/gdocs'
import { GDOCS_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gdocs/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GDOCS_OPS } from '@struktoai/mirage-core/ops/gdocs/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gdocs/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import {
  redactGDocsConfig,
  type GDocsConfig,
  type GDocsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gdocs/config'
export interface GDocsVFSState {
  type: string
  config: GDocsConfigRedacted
}

export class GDocsVFS extends BaseVFS {
  override readonly name: string = VFSName.GDOCS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = GDOCS_PROMPT
  override readonly writePrompt: string = GDOCS_WRITE_PROMPT
  readonly config: GDocsConfig
  override readonly accessor: GDocsAccessor

  constructor(config: GDocsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDocsAccessor({ tokenManager: tm })
  }
  override commands(): readonly RegisteredCommand[] {
    return GDOCS_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GDOCS_OPS
  }
  override getState(): Promise<GDocsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGDocsConfig(this.config),
    })
  }

  override loadState(_state: GDocsVFSState): Promise<void> {
    return Promise.resolve()
  }
}
