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
  PathSpec,
  ResourceName,
  command,
  compilePattern,
  exitOnEmpty,
  formatRecords,
  grepFilesOnly,
  grepLines,
  grepStream,
  mountKey,
  mountPrefixOf,
  prefixAggregate,
  quietMatch,
  resolveGlobOf,
  resolveSource,
  specOf,
  type AsyncReadBytesFn,
  type AsyncReaddirFn,
  type AsyncStatFn,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  yieldBytes,
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
const DEC = new TextDecoder('utf-8', { fatal: false })

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

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
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
  const recursive = opts.flags.r === true || opts.flags.R === true

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

    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    if (resolved.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
    const filePrefix =
      (resolved[0] === undefined
        ? undefined
        : mountPrefixOf(resolved[0].virtual, resolved[0].resourcePath)) ?? ''
    const readdirFn: AsyncReaddirFn = async (path) => {
      const spec = new PathSpec({
        virtual: path,
        directory: path,
        resolved: false,
        resourcePath: mountKey(path, filePrefix),
      })
      return emailReaddir(accessor, spec, opts.index ?? undefined)
    }
    const statFn: AsyncStatFn = async (path) => {
      const spec = new PathSpec({
        virtual: path,
        directory: path,
        resolved: false,
        resourcePath: mountKey(path, filePrefix),
      })
      return emailStat(accessor, spec, opts.index ?? undefined)
    }
    const readBytesFn: AsyncReadBytesFn = async (path) => {
      const spec = new PathSpec({
        virtual: path,
        directory: path,
        resolved: true,
        resourcePath: mountKey(path, filePrefix),
      })
      return emailRead(accessor, spec, opts.index ?? undefined)
    }

    if (f.filesOnly) {
      const warnings: string[] = []
      const firstResolved = resolved[0]
      if (firstResolved === undefined) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const results = await grepFilesOnly(
        readdirFn,
        statFn,
        readBytesFn,
        firstResolved.virtual,
        pattern,
        {
          recursive,
          ignoreCase: f.ignoreCase,
          invert: f.invert,
          lineNumbers: f.lineNumbers,
          countOnly: f.countOnly,
          fixedString: f.fixedString,
          onlyMatching: f.onlyMatching,
          maxCount: f.maxCount,
          wholeWord: f.wholeWord,
        },
        warnings,
      )
      const stderr = warnings.length > 0 ? formatRecords(warnings) : null
      if (results.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1, stderr })]
      const out: ByteSource = formatRecords(results)
      return [out, new IOResult({ stderr })]
    }

    const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord)

    if (resolved.length > 1) {
      const allResults: string[] = []
      for (const p of resolved) {
        const data = splitLinesNoTrailing(
          DEC.decode(await emailRead(accessor, p, opts.index ?? undefined)),
        )
        const hits = grepLines(p.virtual, data, pat, f)
        if (f.countOnly) {
          if (hits.length > 0) allResults.push(`${p.virtual}:${hits[0] ?? ''}`)
        } else {
          for (const h of hits) allResults.push(`${p.virtual}:${h}`)
        }
      }
      if (allResults.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const out: ByteSource = formatRecords(allResults)
      return [out, new IOResult()]
    }

    const firstResolved = resolved[0]
    if (firstResolved === undefined) return [null, new IOResult()]
    const data = await emailRead(accessor, firstResolved, opts.index ?? undefined)
    const source = yieldBytes(data)
    const stream = grepStream(source, pat, f)
    if (f.quiet) {
      const io = new IOResult({ exitCode: 1 })
      return [quietMatch(stream, io), io]
    }
    const io = new IOResult()
    return [exitOnEmpty(stream, io), io]
  }

  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin, 'grep: usage: grep [flags] pattern [path]')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
  }
  const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord)
  const stream = grepStream(source, pat, f)
  if (f.quiet) {
    const io = new IOResult({ exitCode: 1 })
    return [quietMatch(stream, io), io]
  }
  const io = new IOResult()
  return [exitOnEmpty(stream, io), io]
}

export const EMAIL_GREP = command({
  name: 'grep',
  resource: ResourceName.EMAIL,
  spec: specOf('grep'),
  fn: grepCommand,
  aggregate: prefixAggregate,
  provision: fileReadProvision,
})
