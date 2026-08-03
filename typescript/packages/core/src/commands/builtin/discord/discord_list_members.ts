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
import { searchMembers } from '../../../core/discord/members.ts'
import { IOResult } from '../../../io/types.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { CommandSpec, Option } from '../../spec/types.ts'

const ENC = new TextEncoder()

const SPEC = new CommandSpec({
  options: [
    new Option({ long: '--guild_id', type: 'str' }),
    new Option({ long: '--query', type: 'str' }),
  ] })

async function discordListMembersCommand(
  accessor: DiscordAccessor,
  _paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const guildId = opts.flags.guild_id
  const query = opts.flags.query
  if (typeof guildId !== 'string' || guildId === '') {
    throw new Error('--guild_id is required')
  }
  if (typeof query !== 'string' || query === '') {
    throw new Error('--query is required')
  }
  const members = await searchMembers(accessor, guildId, query)
  return [ENC.encode(JSON.stringify(members)), new IOResult()]
}

export const DISCORD_LIST_MEMBERS = command({
  name: 'discord-list-members',
  resource: ResourceName.DISCORD,
  spec: SPEC,
  fn: discordListMembersCommand })
