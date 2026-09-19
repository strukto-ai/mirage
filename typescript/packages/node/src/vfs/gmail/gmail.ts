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

import { GmailAccessor } from '@struktoai/mirage-core/accessor/gmail'
import { GMAIL_COMMANDS } from '@struktoai/mirage-core/commands/builtin/gmail/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { GMAIL_OPS } from '@struktoai/mirage-core/ops/gmail/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { GMAIL_PROMPT, GMAIL_WRITE_PROMPT } from '@struktoai/mirage-core/vfs/gmail/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import {
  redactGmailConfig,
  type GmailConfig,
  type GmailConfigRedacted,
} from '@struktoai/mirage-core/vfs/gmail/config'
export interface GmailVFSState {
  type: string
  config: GmailConfigRedacted
}

export class GmailVFS extends BaseVFS {
  override readonly name: string = VFSName.GMAIL
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: .gmail.json is rendered at
  // readdir from the full message the listing already fetched, and
  // attachments carry the decoded byte count.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = GMAIL_PROMPT
  override readonly writePrompt: string = GMAIL_WRITE_PROMPT
  readonly config: GmailConfig
  override readonly accessor: GmailAccessor

  constructor(config: GmailConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GmailAccessor({ tokenManager: tm })
  }
  override commands(): readonly RegisteredCommand[] {
    return GMAIL_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return GMAIL_OPS
  }
  override getState(): Promise<GmailVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGmailConfig(this.config),
    })
  }

  override loadState(_state: GmailVFSState): Promise<void> {
    return Promise.resolve()
  }
}
