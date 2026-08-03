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
import { addReaction } from '../../../core/discord/react.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--channel_id', type: 'str' }),
    new Option({ long: '--message_id', type: 'str' }),
    new Option({ long: '--reaction', type: 'str' }),
  ],
})

async function discordAddReactionCommand(
  accessor: DiscordAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const channelId = opts.flags.channel_id
  const messageId = opts.flags.message_id
  const reaction = opts.flags.reaction
  if (typeof channelId !== 'string' || channelId === '') {
    throw new Error('--channel_id is required')
  }
  if (typeof messageId !== 'string' || messageId === '') {
    throw new Error('--message_id is required')
  }
  if (typeof reaction !== 'string' || reaction === '') {
    throw new Error('--reaction is required')
  }
  await addReaction(accessor, channelId, messageId, reaction)
  return [ENC.encode(JSON.stringify({ ok: true })), new IOResult()]
}

export const DISCORD_ADD_REACTION = command({
  name: 'discord-add-reaction',
  resource: ResourceName.DISCORD,
  spec: SPEC,
  fn: discordAddReactionCommand,
  write: true,
})
