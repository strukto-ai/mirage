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
import type { GmailAccessor } from '../../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GMAIL_IO } from './io.ts'
import { read as gmailRead } from '../../../core/gmail/read.ts'
import { readdir as gmailReaddir } from '../../../core/gmail/readdir.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/gmail/scope.ts'
import { formatGrepResults, searchMessages } from '../../../core/gmail/search.ts'
import { stat as gmailStat } from '../../../core/gmail/stat.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { type FileStat, type PathSpec, VFSName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { grepGeneric } from '../generic/grep.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand, textSearchResults } from '../grep_pushdown.ts'
import { fileReadProvision } from './_provision.ts'
import { FlagView } from '../../spec/flag_view.ts'

const resolveGlob = resolveGlobOf(GMAIL_IO)

// Gmail search answers with whole messages and the push-down prints that
// answer verbatim, so it can stand in for a scan only when the line names one
// concrete operand and no flag reshapes the output. -w is the exception the
// provider itself supplies: Gmail matches whole words, so a bare literal
// would under-report and only -w makes the two agree.
export const SEARCH_HONORED = ['w'] as const
export const SEARCH_MAX_RESULTS = 50

const ENC = new TextEncoder()

async function* gmailStream(
  accessor: GmailAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await gmailRead(accessor, p, index)
}

async function grepCommand(
  accessor: GmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const fl = new FlagView(opts.flags, specOf('grep'))
  // Output-shaping flags, a glob operand and a multi-operand line all need
  // the generic grep over rendered files; see SEARCH_HONORED above.
  const operand = pushdownOperand(paths, opts.flags, pattern, SEARCH_HONORED)
  if (pattern !== null && operand !== null && fl.asBool('w')) {
    const match = detectScope(operand)
    if (NATIVE_KINDS.has(match.kind)) {
      const labelName = match.slots.label ?? null
      const filePrefix = mountPrefixOf(operand.virtual, operand.vfsPath)
      const rows = await searchMessages(
        accessor.tokenManager,
        pattern,
        labelName,
        match.slots.day ?? null,
        SEARCH_MAX_RESULTS,
      )
      const lines = formatGrepResults(rows, labelName, filePrefix, pattern)
      if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      if (textSearchResults(lines)) {
        const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
        return [out, new IOResult()]
      }
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => gmailStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    gmailReaddir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    gmailStream(accessor, p, opts.index ?? undefined),
  )
}

export const GMAIL_GREP = command({
  name: 'grep',
  vfs: VFSName.GMAIL,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: fileReadProvision,
})
