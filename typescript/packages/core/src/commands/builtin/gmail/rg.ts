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
import type { IndexCacheStore } from '../../../cache/index/index.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GMAIL_IO } from './io.ts'
import { read as gmailRead } from '../../../core/gmail/read.ts'
import { readdir as gmailReaddir } from '../../../core/gmail/readdir.ts'
import { stat as gmailStat } from '../../../core/gmail/stat.ts'
import { detectScope } from '../../../core/gmail/scope.ts'
import { formatGrepResults, searchMessages } from '../../../core/gmail/search.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { type FileStat, type PathSpec, ResourceName } from '../../../types.ts'
import { patternArg } from '../grep_helper.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { rgGeneric } from '../generic/rg.ts'

const resolveGlob = resolveGlobOf(GMAIL_IO)

const ENC = new TextEncoder()

async function* gmailStream(
  accessor: GmailAccessor,
  p: PathSpec,
  index: IndexCacheStore | undefined,
): AsyncIterable<Uint8Array> {
  yield await gmailRead(accessor, p, index)
}

async function rgCommand(
  accessor: GmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags) ?? undefined
  if (pattern === undefined) {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('rg: usage: rg [flags] pattern [path]\n') }),
    ]
  }
  const maxCount = typeof opts.flags.m === 'string' ? Number.parseInt(opts.flags.m, 10) : null

  if (paths.length > 0 && !pattern.includes('\n')) {
    const first = paths[0]
    if (first !== undefined) {
      const scope = detectScope(first)
      if (scope.useNative) {
        const filePrefix =
          mountPrefixOf(first.virtual, first.resourcePath) !== ''
            ? mountPrefixOf(first.virtual, first.resourcePath)
            : ''
        const rows = await searchMessages(
          accessor.tokenManager,
          pattern,
          scope.labelName,
          scope.dateStr,
          maxCount ?? 50,
        )
        const lines = formatGrepResults(rows, scope, filePrefix, pattern)
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
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
  return rgGeneric(resolved, texts, opts, stat, readdir, (p) =>
    gmailStream(accessor, p, opts.index ?? undefined),
  )
}

export const GMAIL_RG = command({
  name: 'rg',
  resource: ResourceName.GMAIL,
  spec: specOf('rg'),
  fn: rgCommand,
})
