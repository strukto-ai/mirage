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

import type { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import { listDatabases } from '../../../core/mongodb/_client.ts'
import { resolveGlob } from '../../../core/mongodb/glob.ts'
import { read as mongoRead } from '../../../core/mongodb/read.ts'
import { readdir as mongoReaddir } from '../../../core/mongodb/readdir.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import { stat as mongoStat } from '../../../core/mongodb/stat.ts'
import {
  formatGrepResults,
  searchCollection,
  searchDatabase,
} from '../../../core/mongodb/search.ts'
import { exitOnEmpty, quietMatch, yieldBytes } from '../../../io/stream.ts'
import { IOResult } from '../../../io/types.ts'
import { type FileStat, FileType, PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { compilePattern, grepFilesOnly, grepRecursive, grepStream } from '../grep_helper.ts'
import { resolveSource } from '../utils/stream.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()

interface GrepFlags {
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

function parseFlags(flags: Record<string, string | boolean>): GrepFlags {
  const toInt = (v: string | boolean | undefined): number | null =>
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

function getPattern(texts: readonly string[], flags: Record<string, string | boolean>): string {
  if (typeof flags.e === 'string') return flags.e
  if (texts.length > 0 && texts[0] !== undefined) return texts[0]
  throw new Error('grep: usage: grep [flags] pattern [path]')
}

async function grepCommand(
  accessor: MongoDBAccessor,
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
  const limit = accessor.config.defaultSearchLimit

  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const scope = detectScope(first)

    if (scope.level === ScopeLevel.ROOT) {
      const dbs = await listDatabases(accessor)
      const results: Awaited<ReturnType<typeof searchDatabase>> = []
      for (const db of dbs) {
        results.push(...(await searchDatabase(accessor, db, pattern, limit)))
      }
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [ENC.encode(allLines.join('\n')), new IOResult()]
    }

    if (scope.level === ScopeLevel.DATABASE && scope.database !== null) {
      const results = await searchDatabase(accessor, scope.database, pattern, limit)
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [ENC.encode(allLines.join('\n')), new IOResult()]
    }

    if (scope.level === ScopeLevel.ENTITY && scope.database !== null && scope.name !== null) {
      const docs = await searchCollection(accessor, scope.database, scope.name, pattern, limit)
      if (docs.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const results = [{ database: scope.database, collection: scope.name, docs }]
      const allLines = formatGrepResults(results)
      return [ENC.encode(allLines.join('\n')), new IOResult()]
    }

    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    const target = resolved[0]
    if (target === undefined) return [null, new IOResult()]
    const filePrefix = target.prefix
    const toScope = (p: string): PathSpec =>
      new PathSpec({ original: p, directory: p, prefix: filePrefix })
    const rd = (p: string): Promise<string[]> =>
      mongoReaddir(accessor, toScope(p), opts.index ?? undefined)
    const st = (p: string): Promise<FileStat> =>
      mongoStat(accessor, toScope(p), opts.index ?? undefined)
    const rb = (p: string): Promise<Uint8Array> =>
      mongoRead(accessor, toScope(p), opts.index ?? undefined)
    const recursive = opts.flags.r === true || opts.flags.R === true
    const warnings: string[] = []

    if (f.filesOnly) {
      const results = await grepFilesOnly(
        rd,
        st,
        rb,
        target.original,
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
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n')) : undefined
      if (results.length === 0) {
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: 1, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      }
      return [
        ENC.encode(results.join('\n') + '\n'),
        new IOResult({ ...(stderr !== undefined ? { stderr } : {}) }),
      ]
    }

    const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord)

    let fileStat: FileStat
    try {
      fileStat = await st(target.original)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`grep: ${msg}\n`) })]
    }
    if (fileStat.type === FileType.DIRECTORY) {
      if (!recursive) {
        return [
          new Uint8Array(0),
          new IOResult({
            exitCode: 1,
            stderr: ENC.encode(`grep: ${target.original}: Is a directory`),
          }),
        ]
      }
      const results = await grepRecursive(
        rd,
        st,
        rb,
        target.original,
        pat,
        {
          recursive: true,
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
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n')) : null
      if (results.length === 0) {
        return [new Uint8Array(0), new IOResult({ exitCode: 1, stderr })]
      }
      return [ENC.encode(results.join('\n')), new IOResult({ stderr })]
    }

    const data = await mongoRead(accessor, target, opts.index ?? undefined)
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

export const MONGODB_GREP = command({
  name: 'grep',
  resource: ResourceName.MONGODB,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: fileReadProvision,
})
