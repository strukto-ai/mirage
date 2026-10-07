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
import { resolveGlobOf, scanIo } from '../generic_bind/index.ts'
import { IO } from './io.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/gmail/scope.ts'
import { formatGrepResults, searchMessages } from '../../../core/gmail/search.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { type FileStat, type PathSpec, VFSName } from '../../../types.ts'
import { patternArg } from '../grep_pattern.ts'
import { pushdownOperand } from '../grep_pushdown.ts'
import { RG_SEARCH_HONORED, SEARCH_MAX_RESULTS } from './grep.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { parseFlags, refuseMissingPattern, rgGeneric } from '../generic/rg.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENC = new TextEncoder()

async function rg(
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
  const [scan, scoped] = scanIo(IO, opts.ns, paths)
  const operand = scoped ? null : pushdownOperand(paths, opts.flags, pattern, RG_SEARCH_HONORED)
  if (operand !== null && pattern !== null && fl.asBool('word_regexp')) {
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
      const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
      return [out, new IOResult()]
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlobOf(scan)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => scan.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    scan.readdir(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    scan.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const GMAIL_RG = command({
  name: 'rg',
  vfs: VFSName.GMAIL,
  spec: specOf('rg'),
  fn: rg,
})
