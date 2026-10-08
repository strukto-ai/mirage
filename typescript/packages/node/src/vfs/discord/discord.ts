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

import { DiscordVFSBase } from '@struktoai/mirage-core/vfs/discord/discord'
import { DiscordAccessor } from '@struktoai/mirage-core/accessor/discord'

import { NodeDiscordTransport } from '@struktoai/mirage-core/core/discord/client'
import { redactDiscordConfig } from '@struktoai/mirage-core/vfs/discord/config'
import type {
  DiscordConfig,
  DiscordConfigRedacted,
} from '@struktoai/mirage-core/vfs/discord/config'

import { PROMPT, WRITE_PROMPT } from '@struktoai/mirage-core/vfs/discord/prompt'
import { VFSName } from '@struktoai/mirage-core/types'

export interface DiscordVFSState {
  type: string
  config: DiscordConfigRedacted
}

export class DiscordVFS extends DiscordVFSBase {
  override readonly name: string = VFSName.DISCORD
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: chat.jsonl and members/*.json
  // are rendered at readdir from payloads the listing already fetched, and
  // attachments carry Discord's CDN byte count.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly prompt: string
  override readonly writePrompt: string = WRITE_PROMPT
  readonly config: DiscordConfig
  override readonly accessor: DiscordAccessor

  constructor(config: DiscordConfig) {
    super()
    this.config = config
    this.accessor = new DiscordAccessor(
      new NodeDiscordTransport(config.token, config.baseUrl),
      config,
    )
    this.prompt = PROMPT + this.accessor.timeRange.prompt()
  }

  override getState(): Promise<DiscordVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactDiscordConfig(this.config),
    })
  }
}
