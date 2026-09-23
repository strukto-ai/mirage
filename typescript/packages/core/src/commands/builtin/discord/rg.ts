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

import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { DiscordAccessor } from '../../../accessor/discord.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { DiscordApiError } from '../../../core/discord/client.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { DISCORD_IO } from './io.ts'
import { read as discordRead } from '../../../core/discord/read.ts'
import { readdir as discordReaddir } from '../../../core/discord/readdir.ts'
import { stat as discordStat } from '../../../core/discord/stat.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/discord/scope.ts'
import { listChannels } from '../../../core/discord/channels.ts'
import { formatGrepResults, searchGuild } from '../../../core/discord/search.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, VFSName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand } from '../grep_pushdown.ts'
import { RG_NO_PATTERN, rgGeneric } from '../generic/rg.ts'
import { SEARCH_HONORED, SEARCH_MAX_RESULTS } from './grep.ts'
import { FlagView } from '../../spec/flag_view.ts'

const resolveDiscordGlob = resolveGlobOf(DISCORD_IO)

const ENC = new TextEncoder()

async function* discordStream(
  accessor: DiscordAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
): AsyncIterable<Uint8Array> {
  yield await discordRead(accessor, p, index)
}

async function rgCommand(
  accessor: DiscordAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  if (pattern === null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${RG_NO_PATTERN}\n`) })]
  }
  const fl = new FlagView(opts.flags, specOf('rg'))

  const pushdownWarnings: string[] = []
  // Same gate as discord grep, from the same table: only a lone concrete
  // operand with no reshaping flag may be answered by the search API.
  const operand = pushdownOperand(paths, opts.flags, pattern, SEARCH_HONORED)
  if (operand !== null && fl.asBool('w')) {
    const match = detectScope(operand)
    if (NATIVE_KINDS.has(match.kind)) {
      const guildId = match.slots.guild_id ?? ''
      const channelId = match.slots.channel_id
      try {
        const count = SEARCH_MAX_RESULTS
        const raw = await searchGuild(accessor, guildId, pattern, channelId, count)
        const channelMap = new Map<string, string>()
        if (channelId === undefined) {
          for (const ch of await listChannels(accessor, guildId)) {
            if (ch.name !== undefined) channelMap.set(ch.id, ch.name)
          }
        }
        const target = {
          guildId,
          ...(match.slots.guild !== undefined ? { guildName: match.slots.guild } : {}),
          ...(match.slots.channel !== undefined ? { channelName: match.slots.channel } : {}),
        }
        const lines = formatGrepResults(
          raw,
          target,
          mountPrefixOf(operand.virtual, operand.vfsPath),
          channelMap,
        )
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        return [ENC.encode(lines.join('\n') + '\n'), new IOResult()]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushdownWarnings.push(
          `discord: native search push-down failed (${msg}); falling back to per-file scan`,
        )
        const status = err instanceof DiscordApiError ? err.status : null
        const lower = msg.toLowerCase()
        if (
          status === 403 ||
          lower.includes('forbidden') ||
          lower.includes('missing permissions') ||
          lower.includes('missing access')
        ) {
          pushdownWarnings.push(
            'discord: hint - ensure the bot has the READ_MESSAGE_HISTORY ' +
              'permission for this guild and the MESSAGE CONTENT privileged ' +
              'intent enabled',
          )
        }
      }
    }
  }

  const resolved =
    paths.length > 0 ? await resolveDiscordGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => discordStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    discordReaddir(accessor, p, opts.index ?? undefined)
  const result = await rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    discordStream(accessor, p, opts.index ?? undefined),
  )
  if (result !== null && pushdownWarnings.length > 0) {
    result[1].stderr = ENC.encode(pushdownWarnings.join('\n') + '\n')
  }
  return result
}

export const DISCORD_RG = command({
  name: 'rg',
  vfs: VFSName.DISCORD,
  spec: specOf('rg'),
  fn: rgCommand,
})
