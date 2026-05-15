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
import { resolveSlackGlob } from '../../../core/slack/glob.ts'
import { read as slackRead } from '../../../core/slack/read.ts'
import { readdir as slackReaddir } from '../../../core/slack/readdir.ts'
import { stat as slackStat } from '../../../core/slack/stat.ts'
import {
  buildQuery,
  formatFileGrepResults,
  formatGrepResults,
} from '../../../core/slack/formatters.ts'
import { detectScope } from '../../../core/slack/scope.ts'
import { searchFiles, searchMessages } from '../../../core/slack/search.ts'
import { exitOnEmpty, quietMatch, yieldBytes } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { type FileStat, PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { compilePattern, grepFilesOnly, grepLines, grepStream } from '../grep_helper.ts'
import { resolveSource } from '../utils/stream.ts'
import { fileReadProvision } from './_provision.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

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

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

async function grepCommand(
  accessor: SlackAccessor,
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

  const pushdownWarnings: string[] = []
  if (paths.length > 0) {
    const firstPath = paths[0]
    if (firstPath !== undefined) {
      const scope = detectScope(firstPath)
      if (scope.useNative) {
        const filePrefix = firstPath.prefix
        const query = buildQuery(pattern, scope)
        const count = f.maxCount ?? 100
        const target = scope.target
        const doMessages = target === undefined || target === 'date' || target === 'messages'
        const doFiles = target === undefined || target === 'date' || target === 'files'
        try {
          const nativeLines: string[] = []
          if (doMessages) {
            const raw = await searchMessages(accessor, query, count)
            nativeLines.push(...formatGrepResults(raw, scope, filePrefix))
          }
          if (doFiles) {
            const rawF = await searchFiles(accessor, query, count)
            nativeLines.push(...formatFileGrepResults(rawF, scope, filePrefix))
          }
          if (nativeLines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
          return [ENC.encode(nativeLines.join('\n') + '\n'), new IOResult()]
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          pushdownWarnings.push(
            `slack: native search push-down failed (${msg}); falling back to per-file scan`,
          )
          if (msg.includes('not_allowed_token_type') || msg.includes('missing_scope')) {
            pushdownWarnings.push(
              'slack: hint - set SLACK_USER_TOKEN (xoxp-) with search:read scope to enable workspace search',
            )
          }
        }
      }
    }
    const resolved = await resolveSlackGlob(accessor, paths, opts.index ?? undefined)
    const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord)

    const stderrFromWarnings = (extra: string[] = []): Uint8Array | undefined => {
      const all = [...pushdownWarnings, ...extra]
      return all.length > 0 ? ENC.encode(all.join('\n') + '\n') : undefined
    }

    if (f.filesOnly) {
      const filePrefix = resolved[0]?.prefix ?? ''
      const toScope = (p: string): PathSpec =>
        new PathSpec({ original: p, directory: p, prefix: filePrefix })
      const rd = (p: string): Promise<string[]> =>
        slackReaddir(accessor, toScope(p), opts.index ?? undefined)
      const st = (p: string): Promise<FileStat> =>
        slackStat(accessor, toScope(p), opts.index ?? undefined)
      const rb = (p: string): Promise<Uint8Array> =>
        slackRead(accessor, toScope(p), opts.index ?? undefined)
      const target = resolved[0]
      if (target === undefined) return [null, new IOResult()]
      const warnings: string[] = []
      const results = await grepFilesOnly(
        rd,
        st,
        rb,
        target.original,
        pattern,
        {
          recursive: opts.flags.r === true || opts.flags.R === true,
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
      const stderr = stderrFromWarnings(warnings)
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

    const stderr = stderrFromWarnings()
    const ioWith = (init: { exitCode?: number } = {}): IOResult =>
      new IOResult({ ...init, ...(stderr !== undefined ? { stderr } : {}) })

    if (resolved.length > 1) {
      const allResults: string[] = []
      for (const p of resolved) {
        const data = splitLinesNoTrailing(
          DEC.decode(await slackRead(accessor, p, opts.index ?? undefined)),
        )
        const hits = grepLines(p.original, data, pat, f)
        if (f.countOnly) {
          if (hits.length > 0) allResults.push(`${p.original}:${hits[0] ?? ''}`)
        } else {
          for (const h of hits) allResults.push(`${p.original}:${h}`)
        }
      }
      if (allResults.length === 0) return [new Uint8Array(0), ioWith({ exitCode: 1 })]
      const out: ByteSource = ENC.encode(allResults.join('\n'))
      return [out, ioWith()]
    }

    const first = resolved[0]
    if (first === undefined) return [null, ioWith()]
    const raw = await slackRead(accessor, first, opts.index ?? undefined)
    const source = yieldBytes(raw)
    const stream = grepStream(source, pat, f)
    if (f.quiet) {
      const io = ioWith({ exitCode: 1 })
      return [quietMatch(stream, io), io]
    }
    const io = ioWith()
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

export const SLACK_GREP = command({
  name: 'grep',
  resource: ResourceName.SLACK,
  spec: specOf('grep'),
  fn: grepCommand,
  provision: fileReadProvision,
})
