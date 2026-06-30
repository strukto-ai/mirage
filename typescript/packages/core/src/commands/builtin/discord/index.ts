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

import type { DiscordAccessor } from '../../../accessor/discord.ts'
import { ResourceName } from '../../../types.ts'
import type { ProvisionFn, RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { metadataProvision } from './_provision.ts'
import { DISCORD_ADD_REACTION } from './discord_add_reaction.ts'
import { DISCORD_GET_SERVER_INFO } from './discord_get_server_info.ts'
import { DISCORD_LIST_MEMBERS } from './discord_list_members.ts'
import { DISCORD_SEND_MESSAGE } from './discord_send_message.ts'
import { DISCORD_FIND } from './find.ts'
import { DISCORD_GREP } from './grep.ts'
import { DISCORD_HEAD } from './head.ts'
import { DISCORD_CMD_OPS } from './ops.ts'
import { DISCORD_RG } from './rg.ts'

const DISCORD_OVERRIDES = new Set(['grep', 'rg', 'find', 'head'])

export const DISCORD_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<DiscordAccessor>(ResourceName.DISCORD, DISCORD_CMD_OPS, {
    overrides: DISCORD_OVERRIDES,
    provisionOverrides: {
      ls: metadataProvision as ProvisionFn,
    },
  }),
  ...DISCORD_FIND,
  ...DISCORD_GREP,
  ...DISCORD_RG,
  ...DISCORD_HEAD,
  ...DISCORD_SEND_MESSAGE,
  ...DISCORD_ADD_REACTION,
  ...DISCORD_GET_SERVER_INFO,
  ...DISCORD_LIST_MEMBERS,
]
