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

import { pathsScoped } from '../../../ops/namespace_view.ts'
import { checkSearch, searchScoped, visibleResults } from '../../../vfs/search.ts'
import type { DiscordAccessor } from '../../../accessor/discord.ts'
import { listChannels } from '../../../core/discord/channels.ts'
import { DiscordApiError } from '../../../core/discord/client.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/discord/scope.ts'
import { formatGrepResults, searchGuild } from '../../../core/discord/search.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, PathSpec } from '../../../types.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { grepGeneric } from '../generic/grep.ts'
import type { Builder, CommandIO } from '../generic_bind/adapter.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand, textSearchResults } from '../grep_pushdown.ts'
import { prependStderr } from '../utils/output.ts'

const ENC = new TextEncoder()

// Discord guild search answers with whole messages and the push-down prints
// that answer verbatim, so it can stand in for a scan only when the line
// names one concrete operand and no flag reshapes the output. -w is the
// exception the provider itself supplies: the search matches whole words, so
// a bare literal would under-report and only -w makes the two agree.
//
// `coalesceScopes` used to widen a set of same-channel chat.jsonl operands
// into one channel-wide search, and it is gone. `searchGuild` takes a channel
// but no date, so folding two named days returned every day the channel ever
// had — and a single chat.jsonl operand was widened the same way. Reporting
// messages the line did not ask for is not a better failure than dropping an
// operand. One operand or the generic scan.
export const SEARCH_HONORED = ['w'] as const
// rg spells the same flag by its long name.
export const RG_SEARCH_HONORED = ['word_regexp'] as const
export const SEARCH_MAX_RESULTS = 100

async function grep(
  ops: CommandIO<DiscordAccessor>,
  accessor: DiscordAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const fl = new FlagView(opts.flags, specOf('grep'))

  const pushdownWarnings: string[] = []
  // Output-shaping flags, a glob operand and a multi-operand line all need
  // the generic scan; see SEARCH_HONORED above.
  const scoped = searchScoped(opts.ns, [PathSpec.fromStrPath((opts.mountPrefix ?? '') || '/')])
  const operand = scoped ? null : pushdownOperand(paths, opts.flags, pattern, SEARCH_HONORED)
  if (pattern !== null && operand !== null && fl.asBool('w')) {
    const match = detectScope(operand)
    if (!accessor.timeRange.bounded && NATIVE_KINDS.has(match.kind)) {
      const guildId = match.slots.guild_id ?? ''
      const channelId = match.slots.channel_id
      const vis = checkSearch([operand])
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
        // A guessed path or a capped search cannot establish the visible result set.
        const complete =
          raw.length < SEARCH_MAX_RESULTS &&
          raw.every(
            (msg) =>
              (channelMap.has(String(msg.channel_id)) ||
                (msg.channel_id === channelId && match.slots.channel !== undefined)) &&
              msg.timestamp,
          )
        if (!pathsScoped(opts.ns, [operand]) || complete) {
          const results = formatGrepResults(
            raw,
            target,
            mountPrefixOf(operand.virtual, operand.vfsPath),
            channelMap,
          )
          const lines = visibleResults(results, vis).map(([, text]) => text)
          if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
          if (textSearchResults(lines)) return [ENC.encode(lines.join('\n') + '\n'), new IOResult()]
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushdownWarnings.push(
          `discord: native search push-down failed (${msg}); ` + `falling back to per-file ops`,
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
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    ops.readdir(accessor, p, opts.index ?? undefined)
  const result = await grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    ops.readStream(accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  if (pushdownWarnings.length > 0) await prependStderr(result[1], pushdownWarnings)
  return result
}

export const BUILDER: Builder<DiscordAccessor> = {
  name: 'grep',
  read: true,
  fn: grep,
}
