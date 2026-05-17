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
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { listDatabases } from '../../../core/mongodb/_client.ts'
import { resolveGlob } from '../../../core/mongodb/glob.ts'
import { read as mongoRead } from '../../../core/mongodb/read.ts'
import { readdir as mongoReaddir } from '../../../core/mongodb/readdir.ts'
import { detectScope } from '../../../core/mongodb/scope.ts'
import { ScopeLevel } from '../../../core/mongodb/types.ts'
import {
  formatGrepResults,
  searchCollection,
  searchDatabase,
} from '../../../core/mongodb/search.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { compilePattern, grepLines } from '../grep_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

interface RgFlags {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  wholeWord: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  hidden: boolean
}

function parseRgFlags(flags: Record<string, string | boolean>): RgFlags {
  const toInt = (v: string | boolean | undefined): number | null =>
    typeof v === 'string' ? Number.parseInt(v, 10) : null
  return {
    ignoreCase: flags.i === true,
    invert: flags.v === true,
    lineNumbers: flags.n === true,
    countOnly: flags.c === true,
    filesOnly: flags.args_l === true,
    wholeWord: flags.w === true,
    fixedString: flags.F === true,
    onlyMatching: flags.o === true,
    maxCount: toInt(flags.m),
    hidden: flags.hidden === true,
  }
}

async function collectFiles(
  accessor: MongoDBAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  let children: string[]
  try {
    children = await mongoReaddir(accessor, path, index)
  } catch {
    return []
  }
  const files: string[] = []
  for (const child of children) {
    if (child.endsWith('.json') || child.endsWith('.jsonl')) {
      files.push(child)
    } else {
      const childSpec = new PathSpec({
        original: child,
        directory: child,
        resolved: false,
        prefix: path.prefix,
      })
      const sub = await collectFiles(accessor, childSpec, index)
      files.push(...sub)
    }
  }
  return files
}

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

async function rgCommand(
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const [exprText] = texts
  if (exprText === undefined) {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('rg: usage: rg [flags] pattern [path]\n') }),
    ]
  }
  const f = parseRgFlags(opts.flags)
  const pat = compilePattern(exprText, f.ignoreCase, f.fixedString, f.wholeWord)
  const limit = accessor.config.defaultSearchLimit

  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const scope = detectScope(first)

    if (scope.level === ScopeLevel.ROOT) {
      const dbs = await listDatabases(accessor)
      const results: Awaited<ReturnType<typeof searchDatabase>> = []
      for (const db of dbs) {
        results.push(...(await searchDatabase(accessor, db, exprText, limit)))
      }
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [ENC.encode(allLines.join('\n')), new IOResult()]
    }
    if (scope.level === ScopeLevel.DATABASE && scope.database !== null) {
      const results = await searchDatabase(accessor, scope.database, exprText, limit)
      const allLines = formatGrepResults(results)
      if (allLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      return [ENC.encode(allLines.join('\n')), new IOResult()]
    }
    if (scope.level === ScopeLevel.ENTITY && scope.database !== null && scope.name !== null) {
      const docs = await searchCollection(accessor, scope.database, scope.name, exprText, limit)
      if (docs.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      const results = [{ database: scope.database, collection: scope.name, docs }]
      const allLines = formatGrepResults(results)
      return [ENC.encode(allLines.join('\n')), new IOResult()]
    }

    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    const filePaths: string[] = []
    const filePrefix = resolved[0]?.prefix ?? ''
    for (const p of resolved) {
      const sub = await collectFiles(accessor, p, opts.index ?? undefined)
      filePaths.push(...sub)
    }
    const sortedFiles = Array.from(new Set(filePaths)).sort()
    const allResults: string[] = []
    let anyMatch = false
    for (const bp of sortedFiles) {
      if (!f.hidden && bp.split('/').some((part) => part.startsWith('.'))) continue
      let data: Uint8Array
      try {
        const bpSpec = new PathSpec({
          original: bp,
          directory: bp,
          resolved: true,
          prefix: filePrefix,
        })
        data = await mongoRead(accessor, bpSpec, opts.index ?? undefined)
      } catch {
        continue
      }
      const text = DEC.decode(data)
      if (text === '') continue
      const lines = splitLinesNoTrailing(text)
      const matched = grepLines(bp, lines, pat, f)
      if (matched.length === 0) continue
      anyMatch = true
      if (f.filesOnly) {
        allResults.push(bp)
        continue
      }
      if (f.countOnly) {
        allResults.push(`${bp}:${String(matched.length)}`)
        continue
      }
      for (const line of matched) {
        allResults.push(`${bp}:${line}`)
      }
    }
    if (!anyMatch) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
    const out: ByteSource = ENC.encode(allResults.join('\n'))
    return [out, new IOResult()]
  }

  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENC.encode('rg: usage: rg [flags] pattern path\n') }),
    ]
  }
  const lines = splitLinesNoTrailing(DEC.decode(raw))
  const matched = grepLines('<stdin>', lines, pat, f)
  if (matched.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
  if (f.countOnly) return [ENC.encode(String(matched.length)), new IOResult()]
  return [ENC.encode(matched.join('\n')), new IOResult()]
}

export const MONGODB_RG = command({
  name: 'rg',
  resource: ResourceName.MONGODB,
  spec: specOf('rg'),
  fn: rgCommand,
})
