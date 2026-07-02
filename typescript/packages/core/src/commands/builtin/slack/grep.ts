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
import {
  buildQuery,
  formatFileGrepResults,
  formatGrepResults,
} from '../../../core/slack/formatters.ts'
import { resolveSlackGlob } from '../../../core/slack/glob.ts'
import { read as slackRead } from '../../../core/slack/read.ts'
import { readdir as slackReaddir } from '../../../core/slack/readdir.ts'
import { detectScope } from '../../../core/slack/scope.ts'
import { searchFiles, searchMessages } from '../../../core/slack/search.ts'
import { stat as slackStat } from '../../../core/slack/stat.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'
import { patternArg } from '../grep_helper.ts'
import { prependStderr } from '../utils/output.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()

async function* slackStream(
  accessor: SlackAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await slackRead(accessor, p, index)
}

async function grepCommand(
  accessor: SlackAccessor,
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
    if (scope.useNative) {
      const filePrefix = mountPrefixOf(firstPath.virtual, firstPath.resourcePath)
      const query = buildQuery(pattern, scope)
      const count = maxCount ?? 100
      const target = scope.target
      const doMessages = target === undefined || target === 'date' || target === 'messages'
      const doFiles = target === undefined || target === 'date' || target === 'files'
      try {
        const nativeLines: string[] = []
        if (doMessages) {
          const raw = await searchMessages(accessor, query, count)
          nativeLines.push(...formatGrepResults(raw, scope, filePrefix))
        }
        if (doFiles) {
          const rawF = await searchFiles(accessor, query, count)
          nativeLines.push(...formatFileGrepResults(rawF, scope, filePrefix))
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
  const result = await grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    slackStream(accessor, p, opts.index ?? undefined),
  )
  if (result === null) return result
  if (pushdownWarnings.length > 0) await prependStderr(result[1], pushdownWarnings)
  return result
}

export const SLACK_GREP = command({
  name: 'grep',
  resource: ResourceName.SLACK,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: fileReadProvision,
})
