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

import { checkSearch, searchScoped, visibleResults } from '../../../vfs/search.ts'
import type { GmailAccessor } from '../../../accessor/gmail.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/gmail/scope.ts'
import { formatGrepResults, searchMessages } from '../../../core/gmail/search.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { pathsScoped } from '../../../ops/namespace_view.ts'
import { PathSpec, type FileStat } from '../../../types.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { parseFlags, refuseMissingPattern, rgGeneric } from '../generic/rg.ts'
import type { Builder, CommandIO } from '../generic_bind/adapter.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand } from '../grep_pushdown.ts'
import { RG_SEARCH_HONORED, SEARCH_MAX_RESULTS } from './grep.ts'

const ENC = new TextEncoder()

async function rg(
  ops: CommandIO<GmailAccessor>,
  accessor: GmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags, 'regexp')
  const fl = new FlagView(opts.flags, specOf('rg'))
  const refused = refuseMissingPattern(pattern, fl, parseFlags(fl))
  if (refused !== null) return refused
  // Same gate as gmail grep, from the same table: only a lone concrete
  // operand with no reshaping flag may be answered by the search API.
  const scoped = searchScoped(opts.ns, [PathSpec.fromStrPath((opts.mountPrefix ?? '') || '/')])
  const operand = scoped ? null : pushdownOperand(paths, opts.flags, pattern, RG_SEARCH_HONORED)
  if (operand !== null && pattern !== null && fl.asBool('word_regexp')) {
    const match = detectScope(operand)
    if (
      NATIVE_KINDS.has(match.kind) &&
      (match.kind !== 'root' || !pathsScoped(opts.ns, [operand]))
    ) {
      const labelName = match.slots.label ?? null
      const filePrefix = mountPrefixOf(operand.virtual, operand.vfsPath)
      const vis = checkSearch([operand])
      const rows = await searchMessages(
        accessor.tokenManager,
        pattern,
        labelName,
        match.slots.day ?? null,
        SEARCH_MAX_RESULTS,
      )
      // A guessed path or a capped search cannot establish the visible result set.
      const complete = rows.length < SEARCH_MAX_RESULTS && rows.every((row) => row.date !== '')
      if (!pathsScoped(opts.ns, [operand]) || complete) {
        const results = formatGrepResults(rows, labelName, filePrefix, pattern)
        const lines = visibleResults(results, vis).map(([, text]) => text)
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
        return [out, new IOResult()]
      }
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    ops.readdir(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    ops.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<GmailAccessor> = {
  name: 'rg',
  read: true,
  fn: rg,
}
