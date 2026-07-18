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
  IOResult,
  ResourceName,
  command,
  compilePattern,
  grepLines,
  mountPrefixOf,
  patternArg,
  resolveGlobOf,
  rgGeneric,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type FileStat,
  type GrepLinesOptions,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { read as emailRead } from '../../../core/email/read.ts'
import { readdir as emailReaddir } from '../../../core/email/readdir.ts'
import { stat as emailStat } from '../../../core/email/stat.ts'
import { detectScope } from '../../../core/email/scope.ts'
import { searchAndFormat } from '../../../core/email/search.ts'
import { EMAIL_IO } from './io.ts'

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
  const pattern = patternArg(texts, opts.flags)
  if (pattern === null) {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('rg: usage: rg [flags] pattern [path]\n') }),
    ]
  }
  const ignoreCase = opts.flags.i === true
  const invert = opts.flags.v === true
  const lineNumbers = opts.flags.n === true
  const countOnly = opts.flags.c === true
  const filesOnly = opts.flags.args_l === true || opts.flags.l === true
  const wholeWord = opts.flags.w === true
  const fixedString = opts.flags.F === true
  const onlyMatching = opts.flags.o === true
  const maxCount = typeof opts.flags.m === 'string' ? Number.parseInt(opts.flags.m, 10) : null
  const pat = compilePattern(pattern, ignoreCase, fixedString, wholeWord)

  const lineOpts: GrepLinesOptions = {
    invert,
    lineNumbers,
    countOnly,
    filesOnly,
    onlyMatching,
    maxCount,
  }

  if (paths.length > 0) {
    const first = paths[0]
    if (first !== undefined) {
      const scope = detectScope(first)
      if (scope.useNative && !pattern.includes('\n')) {
        const filePrefix =
          mountPrefixOf(first.virtual, first.resourcePath) !== ''
            ? mountPrefixOf(first.virtual, first.resourcePath)
            : ''
        const pairs = await searchAndFormat(accessor, scope, pattern, filePrefix, maxCount ?? 50)
        const lines: string[] = []
        for (const [vfsPath, msgText] of pairs) {
          const matched = grepLines(vfsPath, [msgText], pat, lineOpts)
          for (const line of matched) lines.push(`${vfsPath}:${line}`)
        }
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
        return [out, new IOResult()]
      }
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
  resource: ResourceName.EMAIL,
  spec: specOf('rg'),
  fn: rgCommand,
})
