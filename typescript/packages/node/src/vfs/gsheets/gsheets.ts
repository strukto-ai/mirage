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

import { GSheetsAccessor } from '@struktoai/mirage-core/accessor/gsheets'
import { GSHEETS_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gsheets/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GSHEETS_OPS } from '@struktoai/mirage-core/ops/gsheets/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GSHEETS_PROMPT, GSHEETS_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gsheets/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import {
  redactGSheetsConfig,
  type GSheetsConfig,
  type GSheetsConfigRedacted,
} from '@struktoai/mirage-core/vfs/gsheets/config'
export interface GSheetsVFSState {
  type: string
  config: GSheetsConfigRedacted
}

export class GSheetsVFS extends BaseVFS {
  override readonly name: string = VFSName.GSHEETS
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = GSHEETS_PROMPT
  override readonly writePrompt: string = GSHEETS_WRITE_PROMPT
  readonly config: GSheetsConfig
  override readonly accessor: GSheetsAccessor

  constructor(config: GSheetsConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GSheetsAccessor({ tokenManager: tm })
  }
  override commands(): readonly RegisteredCommand[] {
    return GSHEETS_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GSHEETS_OPS
  }
  override getState(): Promise<GSheetsVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGSheetsConfig(this.config),
    })
  }

  override loadState(_state: GSheetsVFSState): Promise<void> {
    return Promise.resolve()
  }
}
