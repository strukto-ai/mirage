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
import { DiscordApiError } from '../../../core/discord/_client.ts'
import { listChannels } from '../../../core/discord/channels.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { DISCORD_CMD_OPS } from './ops.ts'
import { read as discordRead } from '../../../core/discord/read.ts'
import { readdir as discordReaddir } from '../../../core/discord/readdir.ts'
import { detectScope } from '../../../core/discord/scope.ts'
import { formatGrepResults, searchGuild } from '../../../core/discord/search.ts'
import { stat as discordStat } from '../../../core/discord/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'
import { patternArg } from '../grep_helper.ts'
import { prependStderr } from '../utils/output.ts'
import { fileReadProvision } from './_provision.ts'

const resolveDiscordGlob = resolveGlobOf(DISCORD_CMD_OPS)

const ENC = new TextEncoder()

async function* discordStream(
  accessor: DiscordAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await discordRead(accessor, p, index)
}

async function grepCommand(
  accessor: DiscordAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const maxCount = typeof opts.flags.m === 'string' ? Number.parseInt(opts.flags.m, 10) : null

  const pushdownWarnings: string[] = []
  const firstPath = paths[0]
  if (firstPath !== undefined && pattern !== null && !pattern.includes('\n')) {
    const scope = detectScope(firstPath)
    if (scope.useNative && scope.guildId !== undefined) {
      try {
        const count = maxCount ?? 100
        const raw = await searchGuild(accessor, scope.guildId, pattern, scope.channelId, count)
        const channelMap = new Map<string, string>()
        if (scope.channelId === undefined) {
          for (const ch of await listChannels(accessor, scope.guildId)) {
            if (ch.name !== undefined) channelMap.set(ch.id, ch.name)
          }
        }
        const lines = formatGrepResults(
          raw,
          scope,
          mountPrefixOf(firstPath.virtual, firstPath.resourcePath),
          channelMap,
        )
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        return [ENC.encode(lines.join('\n') + '\n'), new IOResult()]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushdownWarnings.push(
          `discord: native search push-down failed (${msg}); ` + `falling back to per-file scan`,
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
  const result = await grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    discordStream(accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  if (pushdownWarnings.length > 0) await prependStderr(result[1], pushdownWarnings)
  return result
}

export const DISCORD_GREP = command({
  name: 'grep',
  resource: ResourceName.DISCORD,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: fileReadProvision,
})
