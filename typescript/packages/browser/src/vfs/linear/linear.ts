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

import { LinearAccessor } from '@struktoai/mirage-core/accessor/linear'
import { LINEAR_COMMANDS } from '@struktoai/mirage-core/commands/builtin/linear/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpLinearTransport } from '@struktoai/mirage-core/core/linear/client'
import { redactLinearConfig } from '@struktoai/mirage-core/core/linear/config'
import type { LinearConfig, LinearConfigRedacted } from '@struktoai/mirage-core/core/linear/config'
import { LINEAR_OPS } from '@struktoai/mirage-core/ops/linear/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { LINEAR_PROMPT, LINEAR_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/linear/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
export interface LinearVFSState {
  type: string
  config: LinearConfigRedacted
}

export class LinearVFS extends BaseVFS {
  override readonly name: string = VFSName.LINEAR
  override readonly cachesReads: boolean = true
  // Every file is sized at its parent's readdir from the listing payload
  // (comments.jsonl via one bounded comments call), so stat always reports
  // the rendered byte length and fskit mounts serve exact reads.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  override readonly prompt: string = LINEAR_PROMPT
  override readonly writePrompt: string = LINEAR_WRITE_PROMPT
  readonly config: LinearConfig
  override readonly accessor: LinearAccessor

  constructor(config: LinearConfig) {
    super()
    this.config = config
    const transportOpts: { apiKey: string; baseUrl?: string } = { apiKey: config.apiKey }
    if (config.baseUrl !== undefined) transportOpts.baseUrl = config.baseUrl
    const accessorOpts: { teamIds?: readonly string[] } = {}
    if (config.teamIds !== undefined) accessorOpts.teamIds = config.teamIds
    this.accessor = new LinearAccessor(new HttpLinearTransport(transportOpts), accessorOpts)
  }
  override commands(): readonly RegisteredCommand[] {
    return LINEAR_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return LINEAR_OPS
  }
  override getState(): Promise<LinearVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactLinearConfig(this.config),
    })
  }

  override loadState(_state: LinearVFSState): Promise<void> {
    return Promise.resolve()
  }
}
