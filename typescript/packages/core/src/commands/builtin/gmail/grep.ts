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
import { grepGeneric } from '../generic/grep.ts'
import type { Builder, CommandIO } from '../generic_bind/adapter.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand, textSearchResults } from '../grep_pushdown.ts'

// Gmail search answers with whole messages and the push-down prints that
// answer verbatim, so it can stand in for a scan only when the line names one
// concrete operand and no flag reshapes the output. -w is the exception the
// provider itself supplies: Gmail matches whole words, so a bare literal
// would under-report and only -w makes the two agree.
export const SEARCH_HONORED = ['w'] as const
// rg spells the same flag by its long name.
export const RG_SEARCH_HONORED = ['word_regexp'] as const
export const SEARCH_MAX_RESULTS = 50

const ENC = new TextEncoder()

async function grep(
  ops: CommandIO<GmailAccessor>,
  accessor: GmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const fl = new FlagView(opts.flags, specOf('grep'))
  // Output-shaping flags, a glob operand and a multi-operand line all need
  // the generic grep over rendered files; see SEARCH_HONORED above.
  const scoped = searchScoped(opts.ns, [PathSpec.fromStrPath((opts.mountPrefix ?? '') || '/')])
  const operand = scoped ? null : pushdownOperand(paths, opts.flags, pattern, SEARCH_HONORED)
  if (pattern !== null && operand !== null && fl.asBool('w')) {
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
        if (textSearchResults(lines)) {
          const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
          return [out, new IOResult()]
        }
      }
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    ops.readdir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    ops.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<GmailAccessor> = {
  name: 'grep',
  read: true,
  fn: grep,
}
