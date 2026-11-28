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

import { DiscordAccessor } from '../../../src/accessor/discord.ts'
import { NodeDiscordTransport } from '../../../src/core/discord/client.ts'
import type { DiscordConfig } from '../../../src/vfs/discord/config.ts'
import {
  DiscordGuild as KitGuild,
  type DiscordFields,
  type DiscordOptions,
} from '../../fixtures/discord_guild.ts'

export * from '../../fixtures/discord_guild.ts'

/** A Discord server on the Discord fake, and a Mirage accessor onto it. */
export class DiscordGuild extends KitGuild {
  /** A mount config on the guild, as the bot. */
  override config(options: DiscordOptions = {}): DiscordConfig & DiscordFields {
    return super.config(options) as DiscordConfig & DiscordFields
  }

  /** A Mirage accessor on the guild, over the real HTTP transport. */
  accessor(options: DiscordOptions = {}): DiscordAccessor {
    const config = this.config(options)
    return new DiscordAccessor(
      new NodeDiscordTransport(config.token, config.baseUrl, config.timeout),
      config,
    )
  }
}
