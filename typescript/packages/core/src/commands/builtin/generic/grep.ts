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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { cacheAwareStream } from '../../../cache/read_through.ts'
import { exitOnEmpty, quietMatch } from '../../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { rebaseRaw } from '../../../utils/path.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import {
  compilePattern,
  countExitStream,
  countRecordsHaveMatches,
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
  onlyMatching: boolean
  maxCount: number | null
  quiet: boolean
  withFilename: boolean
  noFilename: boolean
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
    withFilename: flags.H === true,
    noFilename: flags.h === true,
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
  const f = parseFlags(opts.flags)
  if (resolution.neverMatch) f.fixedString = false
  const recursive = opts.flags.r === true || opts.flags.R === true

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
        for (const h of rebaseRaw(hits, p.virtual, p.rawPath)) results.push(h)
      }
      const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n') + '\n') : undefined
      if (f.quiet)
        return [
          new Uint8Array(0),
          new IOResult({
            exitCode: results.length > 0 ? 0 : 1,
            ...(stderr !== undefined ? { stderr } : {}),
          }),
        ]
      if (results.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: 1, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      // A failed operand fails the command (deliberate divergence: GNU
      // grep uses exit 2 for errors, mirage flattens fs errors to 1);
      // -q above keeps GNU's match-wins rule.
      return [
        ENC.encode(results.join('\n') + '\n'),
        new IOResult({
          exitCode: warnings.length > 0 ? 1 : 0,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
      ]
    }

    const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord)

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
        const s = await statFn(p.virtual)
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
          for (const r of rebaseRaw(res, p.virtual, p.rawPath)) allResults.push(r)
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
      if (f.quiet)
        return [
          new Uint8Array(0),
          new IOResult({
            exitCode: matched ? 0 : 1,
            ...(stderr !== undefined ? { stderr } : {}),
          }),
        ]
      if (allResults.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({ exitCode: 1, ...(stderr !== undefined ? { stderr } : {}) }),
        ]
      return [
        ENC.encode(allResults.join('\n') + '\n'),
        new IOResult({
          exitCode: matched && warnings.length === 0 ? 0 : 1,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
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
          if ((err as { code?: string }).code === 'ENOENT') {
            multiWarnings.push(`${name}: ${p.rawPath}: No such file or directory`)
            continue
          }
          throw err
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
      if (f.quiet)
        return [
          new Uint8Array(0),
          new IOResult({
            exitCode: multiMatched ? 0 : 1,
            ...(multiStderr !== undefined ? { stderr: multiStderr } : {}),
          }),
        ]
      if (allResults.length === 0)
        return [
          new Uint8Array(0),
          new IOResult({
            exitCode: 1,
            ...(multiStderr !== undefined ? { stderr: multiStderr } : {}),
          }),
        ]
      const out: ByteSource = ENC.encode(allResults.join('\n') + '\n')
      return [
        out,
        new IOResult({
          exitCode: multiMatched && multiWarnings.length === 0 ? 0 : 1,
          ...(multiStderr !== undefined ? { stderr: multiStderr } : {}),
        }),
      ]
    }

    const firstStat = await stat(first)
    if (firstStat.type === FileType.DIRECTORY) {
      return [
        new Uint8Array(0),
        new IOResult({
          exitCode: 1,
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
  const pat = compilePattern(pattern, f.ignoreCase, f.fixedString, f.wholeWord)
  const matched = grepStream(source, pat, f)
  if (f.quiet) {
    const io = new IOResult({ exitCode: 1 })
    return [quietMatch(matched, io), io]
  }
  const io = new IOResult()
  if (f.countOnly) return [countExitStream(matched, io), io]
  return [exitOnEmpty(matched, io), io]
}
