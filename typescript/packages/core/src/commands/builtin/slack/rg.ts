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

import type { SlackAccessor } from '../../../accessor/slack.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { resolveSlackGlob } from '../../../core/slack/glob.ts'
import { read as slackRead } from '../../../core/slack/read.ts'
import { readdir as slackReaddir } from '../../../core/slack/readdir.ts'
import { buildQuery, formatGrepResults } from '../../../core/slack/formatters.ts'
import { detectScope } from '../../../core/slack/scope.ts'
import { searchMessages } from '../../../core/slack/search.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
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
  accessor: SlackAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<string[]> {
  let children: string[]
  try {
    children = await slackReaddir(accessor, path, index)
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
  accessor: SlackAccessor,
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

  if (paths.length > 0) {
    const firstPath = paths[0]
    if (firstPath !== undefined) {
      const scope = detectScope(firstPath)
      if (scope.useNative) {
        const filePrefix = firstPath.prefix
        const query = buildQuery(exprText, scope)
        const count = f.maxCount ?? 100
        const raw = await searchMessages(accessor, query, count)
        const lines = formatGrepResults(raw, scope, filePrefix)
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        return [ENC.encode(lines.join('\n') + '\n'), new IOResult()]
      }
    }
    const resolved = await resolveSlackGlob(accessor, paths, opts.index ?? undefined)
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
        data = await slackRead(accessor, bpSpec, opts.index ?? undefined)
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

export const SLACK_RG = command({
  name: 'rg',
  resource: ResourceName.SLACK,
  spec: specOf('rg'),
  fn: rgCommand,
})
