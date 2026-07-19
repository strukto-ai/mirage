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
  grepGeneric,
  grepLines,
  mountPrefixOf,
  prefixAggregate,
  resolveGlobOf,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type FileStat,
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
import { fileReadProvision } from './provision.ts'

const resolveGlob = resolveGlobOf(EMAIL_IO)

const ENC = new TextEncoder()

async function* emailStream(
  accessor: EmailAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await emailRead(accessor, p, index)
}

interface FlagSet {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  wholeWord: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  afterContext: number
  beforeContext: number
}

function parseFlags(flags: Record<string, string | boolean | string[]>): FlagSet {
  const toInt = (v: string | boolean | string[] | undefined): number | null =>
    typeof v === 'string' ? Number.parseInt(v, 10) : null
  const aCtx = toInt(flags.A)
  const bCtx = toInt(flags.B)
  const cCtx = toInt(flags.C)
  return {
    ignoreCase: flags.i === true,
    invert: flags.v === true,
    lineNumbers: flags.n === true,
    countOnly: flags.c === true,
    filesOnly: flags.args_l === true || flags.l === true,
    wholeWord: flags.w === true,
    fixedString: flags.F === true,
    onlyMatching: flags.o === true,
    maxCount: toInt(flags.m),
    quiet: flags.q === true,
    afterContext: aCtx ?? cCtx ?? 0,
    beforeContext: bCtx ?? cCtx ?? 0,
  }
}

function getPattern(
  texts: readonly string[],
  flags: Record<string, string | boolean | string[]>,
): string {
  if (typeof flags.e === 'string') return flags.e
  if (texts.length > 0 && texts[0] !== undefined) return texts[0]
  throw new Error('grep: usage: grep [flags] pattern [path]')
}

async function grepCommand(
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  let pattern: string
  try {
    pattern = getPattern(texts, opts.flags)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
  }
  const f = parseFlags(opts.flags)

  if (paths.length > 0) {
    const first = paths[0]
    if (first !== undefined) {
      const scope = detectScope(first)
      if (scope.useNative && !pattern.includes('\n')) {
        const filePrefix =
          mountPrefixOf(first.virtual, first.resourcePath) !== ''
            ? mountPrefixOf(first.virtual, first.resourcePath)
            : ''
        const pairs = await searchAndFormat(accessor, scope, pattern, filePrefix, f.maxCount ?? 50)
        const lines: string[] = []
        for (const [vfsPath, msgText] of pairs) {
          const matched = grepLines(
            vfsPath,
            [msgText],
            compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord),
            f,
          )
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
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    emailStream(accessor, p, opts.index ?? undefined),
  )
}

export const EMAIL_GREP = command({
  name: 'grep',
  resource: ResourceName.EMAIL,
  spec: specOf('grep'),
  fn: grepCommand,
  aggregate: prefixAggregate,
  provision: fileReadProvision,
})
