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
import type { SlackAccessor } from '../../../accessor/slack.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { SLACK_IO } from './io.ts'
import { read as slackRead } from '../../../core/slack/read.ts'
import { readdir as slackReaddir } from '../../../core/slack/readdir.ts'
import { stat as slackStat } from '../../../core/slack/stat.ts'
import {
  buildQuery,
  formatFileGrepResults,
  formatGrepResults,
} from '../../../core/slack/formatters.ts'
import { detectScope, NATIVE_KINDS, searchTarget } from '../../../core/slack/scope.ts'
import { searchFiles, searchMessages } from '../../../core/slack/search.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, VFSName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand } from '../grep_pushdown.ts'
import { RG_NO_PATTERN, rgGeneric } from '../generic/rg.ts'
import { SEARCH_HONORED, SEARCH_MAX_RESULTS } from './grep.ts'
import { FlagView } from '../../spec/flag_view.ts'

const resolveSlackGlob = resolveGlobOf(SLACK_IO)

const ENC = new TextEncoder()

async function* slackStream(
  accessor: SlackAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
): AsyncIterable<Uint8Array> {
  yield await slackRead(accessor, p, index)
}

async function rgCommand(
  accessor: SlackAccessor,
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
  // Same gate as slack grep, from the same table: only a lone concrete
  // operand with no reshaping flag may be answered by the search API.
  const operand = pushdownOperand(paths, opts.flags, pattern, SEARCH_HONORED)
  if (operand !== null && fl.asBool('w')) {
    const match = detectScope(operand)
    if (NATIVE_KINDS.has(match.kind) && (accessor.transport.searchAvailable?.() ?? true)) {
      const target = searchTarget(match)
      const filePrefix = mountPrefixOf(operand.virtual, operand.vfsPath)
      const query = buildQuery(pattern, target)
      const count = SEARCH_MAX_RESULTS
      // Every kind that reaches here searches messages, and each of them
      // (the root, the containers, a channel, a date dir) carries files
      // too, so both halves run.
      try {
        const raw = await searchMessages(accessor, query, count)
        const nativeLines: string[] = [...formatGrepResults(raw, target, filePrefix)]
        {
          const rawF = await searchFiles(accessor, query, count)
          nativeLines.push(...formatFileGrepResults(rawF, target, filePrefix))
        }
        if (nativeLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        return [ENC.encode(nativeLines.join('\n') + '\n'), new IOResult()]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushdownWarnings.push(
          `slack: native search push-down failed (${msg}); falling back to per-file scan`,
        )
        if (msg.includes('not_allowed_token_type') || msg.includes('missing_scope')) {
          pushdownWarnings.push(
            'slack: hint - set SLACK_USER_TOKEN (xoxp-) with search:read scope to enable workspace search',
          )
        }
      }
    }
  }

  const resolved =
    paths.length > 0 ? await resolveSlackGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => slackStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    slackReaddir(accessor, p, opts.index ?? undefined)
  const result = await rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    slackStream(accessor, p, opts.index ?? undefined),
  )
  if (result !== null && pushdownWarnings.length > 0) {
    result[1].stderr = ENC.encode(pushdownWarnings.join('\n') + '\n')
  }
  return result
}

export const SLACK_RG = command({
  name: 'rg',
  vfs: VFSName.SLACK,
  spec: specOf('rg'),
  fn: rgCommand,
})
