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

import { DiscordAccessor } from '@struktoai/mirage-core/accessor/discord'
import { NodeDiscordTransport } from '@struktoai/mirage-core/core/discord/client'
import { VFSName } from '@struktoai/mirage-core/types'
import { DiscordConfig } from '@struktoai/mirage-core/vfs/discord/config'
import { DiscordVFS as CoreDiscordVFS, VFS_MD } from '@struktoai/mirage-core/vfs/discord/discord'
import type { RedactedSchema } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigState } from '@struktoai/mirage-core/vfs/types'

export class DiscordVFS extends CoreDiscordVFS {
  override readonly name: string = VFSName.DISCORD
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: chat.jsonl and members/*.json
  // are rendered at readdir from payloads the listing already fetched, and
  // attachments carry Discord's CDN byte count.
  override readonly sizesAlwaysKnown: boolean = true
  override vfsMd: string
  readonly config: DiscordConfig
  override readonly accessor: DiscordAccessor

  constructor(config: DiscordConfig) {
    super()
    this.config = config
    this.accessor = new DiscordAccessor(
      new NodeDiscordTransport(config.token, config.baseUrl, config.timeout),
      config,
    )
    this.vfsMd = VFS_MD + this.accessor.timeRange.vfsMd()
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof DiscordConfig>>> {
    return Promise.resolve(this.configState(DiscordConfig, this.config))
  }
}
