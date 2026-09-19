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

import { LangfuseAccessor } from '@struktoai/mirage-core/accessor/langfuse'
import { LANGFUSE_COMMANDS } from '@struktoai/mirage-core/commands/builtin/langfuse/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpLangfuseTransport } from '@struktoai/mirage-core/core/langfuse/client'
import { LANGFUSE_OPS } from '@struktoai/mirage-core/ops/langfuse/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { LANGFUSE_PROMPT } from '@struktoai/mirage-core/vfs/langfuse/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import { redactLangfuseConfig, type LangfuseConfig, type LangfuseConfigRedacted } from './config.ts'
export interface LangfuseVFSState {
  type: string
  config: LangfuseConfigRedacted
}

export class LangfuseVFS extends BaseVFS {
  override readonly name: string = VFSName.LANGFUSE
  override readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  override readonly prompt: string = LANGFUSE_PROMPT
  readonly config: LangfuseConfig
  override readonly accessor: LangfuseAccessor

  constructor(config: LangfuseConfig) {
    super()
    this.config = config
    const transportOpts: { publicKey: string; secretKey: string; host?: string } = {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    }
    if (config.host !== undefined) transportOpts.host = config.host
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultSearchLimit?: number
      defaultFromTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultSearchLimit !== undefined) {
      accessorConfig.defaultSearchLimit = config.defaultSearchLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    this.accessor = new LangfuseAccessor(new HttpLangfuseTransport(transportOpts), accessorConfig)
  }
  override commands(): readonly RegisteredCommand[] {
    return LANGFUSE_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return LANGFUSE_OPS
  }
  override getState(): Promise<LangfuseVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactLangfuseConfig(this.config),
    })
  }

  override loadState(_state: LangfuseVFSState): Promise<void> {
    return Promise.resolve()
  }
}
