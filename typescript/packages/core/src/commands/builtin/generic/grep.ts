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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { isMissingPath } from '../../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { cacheAwareStream } from '../../../cache/read_through.ts'
import { exitOnEmpty, quietMatch } from '../../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { respellRaw } from '../../../utils/path.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  compilePattern,
  countExitStream,
  countRecordsHaveMatches,
  exitCodeFor,
  grepFilesOnly,
  type GrepFilesOnlyOptions,
  grepLines,
  grepRecursive,
  grepStream,
  prefixLines,
  resolvePatternFromFlags,
} from '../grep_helper.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

interface FlagSet {
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  wholeWord: boolean
  fixedString: boolean
  basicRegexp: boolean
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  withFilename: boolean
  noFilename: boolean
  afterContext: number
  beforeContext: number
}

function parseFlags(fl: FlagView): FlagSet {
  const aCtx = fl.asInt('A')
  const bCtx = fl.asInt('B')
  const cCtx = fl.asInt('C')
  return {
    ignoreCase: fl.asBool('i'),
    invert: fl.asBool('v'),
    lineNumbers: fl.asBool('n'),
    countOnly: fl.asBool('c'),
    filesOnly: fl.asBool('args_l'),
    wholeWord: fl.asBool('w'),
    fixedString: fl.asBool('F'),
    // grep reads a basic expression unless -E says otherwise; -G asks for the
    // default explicitly.
    basicRegexp: !fl.asBool('E'),
    onlyMatching: fl.asBool('o'),
    maxCount: fl.asInt('m') ?? null,
    quiet: fl.asBool('q'),
    withFilename: fl.asBool('H'),
    noFilename: fl.asBool('h'),
    afterContext: aCtx ?? cCtx ?? 0,
    beforeContext: bCtx ?? cCtx ?? 0,
  }
}

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function makeSpec(path: string, template: PathSpec): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, mountPrefixOf(template.virtual, template.resourcePath)),
  })
}

function filesOnlyOpts(f: FlagSet, recursive: boolean): GrepFilesOnlyOptions {
  return {
    recursive,
    ignoreCase: f.ignoreCase,
    invert: f.invert,
    lineNumbers: f.lineNumbers,
    countOnly: f.countOnly,
    fixedString: f.fixedString,
    onlyMatching: f.onlyMatching,
    maxCount: f.maxCount,
    wholeWord: f.wholeWord,
    basic: f.basicRegexp,
  }
}

export async function grepGeneric(
  name: string,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('grep'))
  stream = cacheAwareStream(stream)
  const resolution = await resolvePatternFromFlags(
    name,
    texts,
    opts.flags,
    paths,
    opts.mountPrefix,
    stream,
  )
  if (resolution.error !== null) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(resolution.error) })]
  }
  const pattern = resolution.pattern
  if (pattern === null) {
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode(`${name}: usage: ${name} [flags] pattern [path]\n`),
      }),
    ]
  }
  const f = parseFlags(fl)
  if (resolution.neverMatch) f.fixedString = false
  const recursive = fl.asBool('r') || fl.asBool('R')

  if (paths.length > 0) {
    const first = paths[0]
    if (first === undefined) return [null, new IOResult()]
    const readdirFn = (p: string): Promise<string[]> => readdir(makeSpec(p, first))
    const statFn = (p: string): Promise<FileStat> => stat(makeSpec(p, first))
    const readBytesFn = (p: string): Promise<Uint8Array> => materialize(stream(makeSpec(p, first)))

    if (f.filesOnly) {
      const warnings: string[] = []
      const results: string[] = []
      for (const p of paths) {
        const hits = await grepFilesOnly(
          readdirFn,
          statFn,
          readBytesFn,
          p.virtual,
          pattern,
          filesOnlyOpts(f, recursive),
          warnings,
        )
        for (const h of respellRaw(hits, p.virtual, p.rawPath)) results.push(h)
      }
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
      // Under -c a result is a count, and a zero count is not a match, so
      // emptiness alone cannot decide the exit status.
      const hit = results.length > 0 && (!f.countOnly || countRecordsHaveMatches(results))
      const code = exitCodeFor(hit, warnings.length > 0, f.quiet)
      if (f.quiet || results.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      return [
        ENC.encode(results.join('\n') + '\n'),
        new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) }),
      ]
    }

    const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord, f.basicRegexp)

    if (recursive) {
      // OPTIMIZATION (see #207): this buffers every match into allResults and returns it
      // materialized, so `grep -r PATTERN dir | head -n 3` still scans the whole
      // tree before head sees a line. For plain line output (not -c/-l, which
      // must aggregate) this could instead yield prefixed matches lazily per file
      // as an async iterable wrapped in exitOnEmpty, letting an early-exiting
      // consumer (head, grep -m, grep -q) abort the walk after enough matches.
      const warnings: string[] = []
      const allResults: string[] = []
      for (const p of paths) {
        let s: FileStat
        try {
          s = await statFn(p.virtual)
        } catch (err) {
          if (!isMissingPath(err)) throw err
          warnings.push(`${name}: ${p.rawPath}: No such file or directory`)
          continue
        }
        if (s.type === FileType.DIRECTORY) {
          const res = await grepRecursive(
            readdirFn,
            statFn,
            readBytesFn,
            p.virtual,
            pat,
            filesOnlyOpts(f, recursive),
            warnings,
            false,
          )
          for (const r of respellRaw(res, p.virtual, p.rawPath)) allResults.push(r)
        } else {
          const data = splitLinesNoTrailing(DEC.decode(await readBytesFn(p.virtual)))
          const hits = grepLines(p.rawPath, data, pat, f)
          const label = f.noFilename ? '' : `${p.rawPath}:`
          if (f.countOnly) {
            if (hits.length > 0) allResults.push(`${label}${hits[0] ?? ''}`)
          } else {
            for (const rl of hits) allResults.push(`${label}${rl}`)
          }
        }
      }
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
      const matched = allResults.length > 0 && (!f.countOnly || countRecordsHaveMatches(allResults))
      const code = exitCodeFor(matched, warnings.length > 0, f.quiet)
      if (f.quiet || allResults.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      return [
        ENC.encode(allResults.join('\n') + '\n'),
        new IOResult({ exitCode: code, ...(stderr !== undefined ? { stderr } : {}) }),
      ]
    }

    if (paths.length > 1) {
      const allResults: string[] = []
      const multiWarnings: string[] = []
      for (const p of paths) {
        let s: FileStat
        try {
          s = await statFn(p.virtual)
        } catch (err) {
          if (!isMissingPath(err)) throw err
          multiWarnings.push(`${name}: ${p.rawPath}: No such file or directory`)
          continue
        }
        if (s.type === FileType.DIRECTORY) {
          multiWarnings.push(`${name}: ${p.rawPath}: Is a directory`)
          continue
        }
        const data = splitLinesNoTrailing(DEC.decode(await materialize(stream(p))))
        const hits = grepLines(p.rawPath, data, pat, f)
        const label = f.noFilename ? '' : `${p.rawPath}:`
        if (f.countOnly) {
          if (hits.length > 0) allResults.push(`${label}${hits[0] ?? ''}`)
        } else {
          for (const h of hits) allResults.push(`${label}${h}`)
        }
      }
      const multiStderr =
        multiWarnings.length > 0 ? ENC.encode(multiWarnings.join('\n') + '\n') : undefined
      const multiMatched =
        allResults.length > 0 && (!f.countOnly || countRecordsHaveMatches(allResults))
      const multiCode = exitCodeFor(multiMatched, multiWarnings.length > 0, f.quiet)
      if (f.quiet || allResults.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({
            exitCode: multiCode,
            ...(multiStderr !== undefined ? { stderr: multiStderr } : {}),
          }),
        ]
      const out: ByteSource = ENC.encode(allResults.join('\n') + '\n')
      return [
        out,
        new IOResult({
          exitCode: multiCode,
          ...(multiStderr !== undefined ? { stderr: multiStderr } : {}),
        }),
      ]
    }

    // An unreadable operand is grep's own error to report, not the
    // dispatcher's: the shared handler flattens every filesystem error to
    // exit 1, which is right for cat and wrong for grep.
    let firstStat: FileStat
    try {
      firstStat = await stat(first)
    } catch (err) {
      if (!isMissingPath(err)) throw err
      return [
        new Uint8Array(0),
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode(`${name}: ${first.rawPath}: No such file or directory\n`),
        }),
      ]
    }
    if (firstStat.type === FileType.DIRECTORY) {
      return [
        new Uint8Array(0),
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode(`${name}: ${first.rawPath}: Is a directory\n`),
        }),
      ]
    }
    const source = stream(first)
    const matched = grepStream(source, pat, f)
    if (f.quiet) {
      const io = new IOResult({ exitCode: 1 })
      return [quietMatch(matched, io), io]
    }
    const io = new IOResult()
    let out = f.countOnly ? countExitStream(matched, io) : exitOnEmpty(matched, io)
    if (f.withFilename && f.afterContext === 0 && f.beforeContext === 0) {
      // GNU labels context lines with `-` instead of `:`, which the uniform
      // prefix cannot reproduce, so -H skips context output.
      out = prefixLines(out, `${first.rawPath}:`)
    }
    return [out, io]
  }

  let source: AsyncIterable<Uint8Array>
  try {
    source = resolveSource(opts.stdin, `${name}: usage: ${name} [flags] pattern [path]`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
  }
  const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord, f.basicRegexp)
  const matched = grepStream(source, pat, f)
  if (f.quiet) {
    const io = new IOResult({ exitCode: 1 })
    return [quietMatch(matched, io), io]
  }
  const io = new IOResult()
  if (f.countOnly) return [countExitStream(matched, io), io]
  return [exitOnEmpty(matched, io), io]
}
