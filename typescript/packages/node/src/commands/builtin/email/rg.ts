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

import {
  parseFlags,
  refuseMissingPattern,
  rgGeneric,
  rgMatcher,
  rgSyntax,
} from '@struktoai/mirage-core/commands/builtin/generic/rg'
import type {
  Builder,
  CommandIO,
} from '@struktoai/mirage-core/commands/builtin/generic_bind/adapter'
import { resolveGlobOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { patternArg } from '@struktoai/mirage-core/commands/builtin/grep_pattern'
import { pushdownOperand, searchQuery } from '@struktoai/mirage-core/commands/builtin/grep_pushdown'
import type { GrepLinesOptions } from '@struktoai/mirage-core/commands/builtin/grep_scan'
import { grepLines } from '@struktoai/mirage-core/commands/builtin/grep_scan'
import type { CommandFnResult, CommandOpts } from '@struktoai/mirage-core/commands/config'
import { FlagView, specOf } from '@struktoai/mirage-core/commands/spec/index'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { pathsScoped } from '@struktoai/mirage-core/ops/namespace_view'
import type { FileStat } from '@struktoai/mirage-core/types'
import { PathSpec } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/email/scope.ts'
import { searchAndFormat } from '../../../core/email/search.ts'
import { messageLines, RG_SEARCH_HONORED } from './grep.ts'

const ENC = new TextEncoder()

async function rg(
  ops: CommandIO<EmailAccessor>,
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
  const scoped = pathsScoped(opts.ns, [PathSpec.fromStrPath((opts.mountPrefix ?? '') || '/')])
  const operand = scoped ? null : pushdownOperand(paths, opts.flags, pattern, RG_SEARCH_HONORED)
  // The server is asked for the literal every match must contain, never
  // the regex's own spelling: IMAP TEXT is a substring search.
  const query = pattern === null ? null : searchQuery(pattern, f.fixedString, rgSyntax(f))
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
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    ops.readdir(accessor, p, opts.index ?? undefined)
  return rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    ops.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<EmailAccessor> = {
  name: 'rg',
  read: true,
  fn: rg,
}
