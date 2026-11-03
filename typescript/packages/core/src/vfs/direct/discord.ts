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

import { DiscordAccessor } from '../../accessor/discord.ts'
import { NodeDiscordTransport } from '../../core/discord/client.ts'
import { VFSName } from '../../types.ts'
import { DiscordConfig } from '../discord/config.ts'
import { DiscordVFS as CoreDiscordVFS, VFS_MD } from '../discord/discord.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState } from '../types.ts'

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
