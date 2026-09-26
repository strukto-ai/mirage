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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import {
  parseFlags,
  refuseMissingPattern,
  rgGeneric,
  rgMatcher,
} from '@struktoai/mirage-core/commands/builtin/generic/rg'
import { resolveGlobOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { patternArg } from '@struktoai/mirage-core/commands/builtin/grep_pattern'
import { pushdownOperand, searchQuery } from '@struktoai/mirage-core/commands/builtin/grep_pushdown'
import { grepLines } from '@struktoai/mirage-core/commands/builtin/grep_scan'
import type { GrepLinesOptions } from '@struktoai/mirage-core/commands/builtin/grep_scan'
import { command } from '@struktoai/mirage-core/commands/config'
import type { CommandFnResult, CommandOpts } from '@struktoai/mirage-core/commands/config'
import { FlagView, specOf } from '@struktoai/mirage-core/commands/spec/index'
import { IOResult } from '@struktoai/mirage-core/io/types'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { VFSName } from '@struktoai/mirage-core/types'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { read as emailRead } from '../../../core/email/read.ts'
import { readdir as emailReaddir } from '../../../core/email/readdir.ts'
import { stat as emailStat } from '../../../core/email/stat.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/email/scope.ts'
import { searchAndFormat } from '../../../core/email/search.ts'
import { EMAIL_IO } from './io.ts'
import { RG_SEARCH_HONORED, messageLines } from './grep.ts'

const resolveGlob = resolveGlobOf(EMAIL_IO)

const ENC = new TextEncoder()

async function* emailStream(
  accessor: EmailAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
): AsyncIterable<Uint8Array> {
  yield await emailRead(accessor, p, index)
}

async function rgCommand(
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags, 'regexp')
  const fl = new FlagView(opts.flags, specOf('rg'))
  const f = parseFlags(fl)
  const refused = refuseMissingPattern(pattern, fl, f)
  if (refused !== null) return refused
  const lineOpts: GrepLinesOptions = {
    invert: false,
    lineNumbers: f.lineNumbers,
    countOnly: false,
    filesOnly: f.filesOnly,
    onlyMatching: f.onlyMatching,
    maxCount: f.maxCount,
  }

  // Same gate as email grep, from the same table, and it reads the scope the
  // same way: a line the push-down cannot answer takes the generic scan.
  const operand = pushdownOperand(paths, opts.flags, pattern, RG_SEARCH_HONORED)
  // The server is asked for the literal every match must contain, never
  // the regex's own spelling: IMAP TEXT is a substring search.
  const query = pattern === null ? null : searchQuery(pattern, f.fixedString)
  if (operand !== null && pattern !== null && query !== null) {
    const match = detectScope(operand)
    if (NATIVE_KINDS.has(match.kind)) {
      const filePrefix = mountPrefixOf(operand.virtual, operand.vfsPath)
      const pairs = await searchAndFormat(
        accessor,
        match.slots.folder ?? '',
        query,
        filePrefix,
        accessor.config.maxMessages,
      )
      const pat = rgMatcher(pattern, false, f)
      const lines: string[] = []
      for (const [vfsPath, msgText] of pairs) {
        const matched = grepLines(vfsPath, messageLines(msgText), pat, lineOpts)
        if (matched.length === 0) continue
        if (lineOpts.filesOnly) {
          lines.push(vfsPath)
          continue
        }
        for (const line of matched) lines.push(`${vfsPath}:${line}`)
      }
      if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
      return [out, new IOResult()]
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => emailStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    emailReaddir(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    emailStream(accessor, p, opts.index ?? undefined),
  )
}

export const EMAIL_RG = command({
  name: 'rg',
  vfs: VFSName.EMAIL,
  spec: specOf('rg'),
  fn: rgCommand,
})
