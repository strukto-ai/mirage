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

import { breToRegExp } from '../../utils/bre.ts'
import { isMissingPath } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { materialize, type IOResult } from '../../io/types.ts'
import { type FileStat, FileType, PathSpec } from '../../types.ts'
import { getExtension } from '../resolve.ts'
import { PatternType } from './constants.ts'
import { grepContextLines } from './grep_context.ts'
import type { AsyncReadBytesFn, AsyncReaddirFn, AsyncStatFn } from './utils/types.ts'
import type { FlagValue } from '../spec/types.ts'

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.parquet',
  '.orc',
  '.feather',
  '.arrow',
  '.ipc',
  '.hdf5',
  '.h5',
])

export const NEVER_MATCH = '(?!)'

const DEC = new TextDecoder()

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Resolve the pattern-list argument from -e values (list[str] when
// multiple) or the positional. Returns the POSIX newline-joined pattern
// list, or null when neither was supplied.
export function patternArg(
  texts: readonly string[],
  flags: Record<string, FlagValue>,
): string | null {
  const e = flags.e
  if (Array.isArray(e) && e.length > 0) return e.join('\n')
  if (typeof e === 'string') return e
  if (texts.length > 0 && texts[0] !== undefined) return texts[0]
  return null
}

export interface PatternResolution {
  pattern: string | null
  neverMatch: boolean
  error: string | null
}

// Resolve the full pattern list from -e values, the positional, and -f
// pattern files (read via the backend stream). Shared by the grep, rg, and
// zgrep generics. When -f supplies zero patterns the NEVER_MATCH sentinel is
// returned with neverMatch=true (callers must skip -F escaping for it).
export async function resolvePatternFromFlags(
  name: string,
  texts: readonly string[],
  flags: Record<string, FlagValue>,
  paths: readonly PathSpec[],
  mountPrefix: string | null | undefined,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<PatternResolution> {
  let pattern = patternArg(texts, flags)
  let neverMatch = false
  if (Array.isArray(flags.f)) {
    const first = paths[0]
    const prefix =
      (first === undefined ? undefined : mountPrefixOf(first.virtual, first.resourcePath)) ??
      mountPrefix ??
      ''
    for (const filePath of flags.f) {
      const patternSpec = PathSpec.fromStrPath(filePath, mountKey(filePath, prefix))
      let fileData: Uint8Array
      try {
        fileData = await materialize(stream(patternSpec))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { pattern: null, neverMatch: false, error: `${name}: ${filePath}: ${msg}\n` }
      }
      pattern = mergePatternList(pattern, fileData)
    }
    if (pattern === null) {
      pattern = NEVER_MATCH
      neverMatch = true
    }
  }
  return { pattern, neverMatch, error: null }
}

export function mergePatternList(
  pattern: string | null,
  fileData: Uint8Array | null,
): string | null {
  const parts: string[] = pattern === null ? [] : pattern.split('\n')
  if (fileData !== null && fileData.length > 0) {
    let text = DEC.decode(fileData)
    if (text.endsWith('\n')) text = text.slice(0, -1)
    parts.push(...text.split('\n'))
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

// One pattern's regex source, in the syntax it was written in.
function sourceOf(part: string, fixedString: boolean, basic: boolean): string {
  if (fixedString) return escapeRegex(part)
  return basic ? breToRegExp(part) : part
}

// Build a regex source string from a POSIX pattern list. `basic` says the
// patterns are basic regular expressions, which grep reads by default and which
// invert most of the RegExp operators; false leaves them alone, which is right
// for -E and for rg's own dialect.
function buildPatternStr(
  pattern: string,
  fixedString = false,
  wholeWord = false,
  basic = false,
): string {
  const parts = pattern.split('\n')
  if (parts.length === 1) {
    let patStr = sourceOf(pattern, fixedString, basic)
    if (wholeWord) patStr = `\\b${patStr}\\b`
    return patStr
  }
  const subs: string[] = []
  for (const part of parts) {
    const source = sourceOf(part, fixedString, basic)
    let sub = fixedString ? source : `(?:${source})`
    if (wholeWord) sub = `\\b${sub}\\b`
    subs.push(sub)
  }
  return subs.join('|')
}

export function compilePattern(
  pattern: string,
  ignoreCase = false,
  fixedString = false,
  wholeWord = false,
  basic = false,
): RegExp {
  return new RegExp(buildPatternStr(pattern, fixedString, wholeWord, basic), ignoreCase ? 'i' : '')
}

export function isRegexPattern(pattern: string, fixedString: boolean): boolean {
  if (pattern.includes('\n')) return true
  if (fixedString) return false
  return !/^[\w\s\-.]+$/.test(pattern)
}

// Classify a grep pattern for API push-down decisions.
export function classifyPattern(pattern: string, fixedString: boolean): PatternType {
  if (pattern.includes('\n')) return PatternType.REGEX
  if (fixedString) return PatternType.EXACT
  if (/^[\w\s\-_.]+$/.test(pattern)) return PatternType.SIMPLE
  return PatternType.REGEX
}

const REGEX_BREAKERS: ReadonlySet<string> = new Set('.^$*+?()|{}')
const MIN_SEARCH_LITERAL = 3

// Longest substring every match of a regex must contain. Returns a literal
// any matching line is guaranteed to contain, suitable for narrowing via a
// literal search API before the real regex is scanned locally. Conservative:
// returns null whenever a required literal cannot be proven (top-level
// alternation, character classes, escapes, runs shorter than
// MIN_SEARCH_LITERAL), so the caller falls back to a full scan.
export function extractRequiredLiteral(pattern: string): string | null {
  if (pattern.includes('|')) return null
  const runs: string[] = []
  let current: string[] = []
  let i = 0
  const n = pattern.length
  while (i < n) {
    const ch = pattern.charAt(i)
    if (ch === '\\') {
      runs.push(current.join(''))
      current = []
      i += 2
      continue
    }
    if (ch === '[') {
      runs.push(current.join(''))
      current = []
      i += 1
      while (i < n && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (REGEX_BREAKERS.has(ch)) {
      if ((ch === '*' || ch === '?' || ch === '{') && current.length > 0) current.pop()
      runs.push(current.join(''))
      current = []
      if (ch === '{') {
        while (i < n && pattern[i] !== '}') i += 1
      }
      i += 1
      continue
    }
    current.push(ch)
    i += 1
  }
  runs.push(current.join(''))
  let best = ''
  for (const r of runs) if (r.length > best.length) best = r
  return best.length >= MIN_SEARCH_LITERAL ? best : null
}

// Literal to push down to a code-search API for a grep/rg pattern: the
// pattern itself when literal, a required literal extracted from a regex, or
// null when no literal can be searched.
export function searchQuery(pattern: string, fixedString: boolean): string | null {
  if (classifyPattern(pattern, fixedString) !== PatternType.REGEX) return pattern
  return extractRequiredLiteral(pattern)
}

// Whether the pattern is searched verbatim, with no regex extraction.
// Push-down against a whole-word search index is only complete when the term
// handed to the provider is the entire match. A regex narrowed on an extracted
// literal fails that: `foo[0-9]` under -w matches `foo1`, but a whole-word
// search for `foo` never returns a file whose only token is `foo1`.
export function isLiteralPattern(pattern: string, fixedString: boolean): boolean {
  if (fixedString) return true
  const pt = classifyPattern(pattern, fixedString)
  return pt === PatternType.EXACT || (pt === PatternType.SIMPLE && !pattern.includes('.'))
}

// True when a flag alters the match set or output shape of grep/rg. A search
// push-down prints each matching record as one whole line, so it cannot honor
// -v/-n/-c/-l/-w/-o/-m/-A/-B/-C/-q/-H/-h, rg's -I (no filename), nor rg's
// file-filtering --glob/--type; the wrapper must defer to the generic scan
// when any is present.
export function hasSearchShapingFlags(flags: Record<string, FlagValue>): boolean {
  if (
    flags.v === true ||
    flags.n === true ||
    flags.c === true ||
    flags.args_l === true ||
    flags.l === true ||
    flags.w === true ||
    flags.o === true ||
    flags.q === true ||
    flags.H === true ||
    flags.h === true ||
    flags.args_I === true
  ) {
    return true
  }
  return (
    typeof flags.m === 'string' ||
    typeof flags.A === 'string' ||
    typeof flags.B === 'string' ||
    typeof flags.C === 'string' ||
    flags.type !== undefined ||
    flags.glob !== undefined
  )
}

// True when a literal-substring push-down (LIKE/ILIKE) faithfully reproduces
// grep/rg: a literal pattern with no shaping flags. A newline-joined pattern
// list (-F with multiple -e) is a set of independent alternatives LIKE cannot
// express, so it stays on the generic path. Backends that push a real regex
// down (mongodb) gate on hasSearchShapingFlags alone instead.
export function searchPushdownOk(flags: Record<string, FlagValue>, pattern: string): boolean {
  if (pattern.includes('\n')) return false
  return isLiteralPattern(pattern, flags.F === true) && !hasSearchShapingFlags(flags)
}

export interface GrepLinesOptions {
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  onlyMatching: boolean
  maxCount: number | null
}

export function grepLines(
  path: string,
  data: readonly string[],
  compiled: RegExp,
  opts: GrepLinesOptions,
): string[] {
  const results: string[] = []
  let count = 0
  const reGlobal = opts.onlyMatching
    ? new RegExp(
        compiled.source,
        compiled.flags.includes('g') ? compiled.flags : compiled.flags + 'g',
      )
    : null
  for (let i = 0; i < data.length; i++) {
    const line = data[i] ?? ''
    const found = compiled.test(line)
    const matched = opts.invert ? !found : found
    if (!matched) continue
    count += 1
    if (!opts.countOnly && !opts.filesOnly) {
      let text: string
      if (opts.onlyMatching && !opts.invert && reGlobal !== null) {
        reGlobal.lastIndex = 0
        const m = reGlobal.exec(line)
        text = m !== null ? m[0] : line
      } else {
        text = line
      }
      const prefix = opts.lineNumbers ? `${String(i + 1)}:${text}` : text
      results.push(prefix)
    }
    if (opts.maxCount !== null && count >= opts.maxCount) break
  }
  if (opts.countOnly) return [String(count)]
  if (opts.filesOnly) return count > 0 ? [path] : []
  return results
}

// Whether any `path:count` record has a nonzero count.
export function countRecordsHaveMatches(results: readonly string[]): boolean {
  return results.some((r) => Number.parseInt(r.slice(r.lastIndexOf(':') + 1), 10) > 0)
}

// Drop zero-count chunks for the `rg -c` fallback stream. Unlike grep -c
// (which prints "0" and exits 1), ripgrep omits files with no matches.
// Mirrors Python's nonzero_count_stream.
export async function* nonzeroCountStream(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (Number.parseInt(DEC.decode(chunk).trim() || '0', 10) > 0) yield chunk
  }
}

// Yield count-only grep output, setting exit 1 when all counts are zero.
// GNU grep -c prints the count but still exits 1 when no lines were
// selected, so emptiness-based exit detection cannot apply.
export async function* countExitStream(
  source: AsyncIterable<Uint8Array>,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  let anyMatch = false
  for await (const chunk of source) {
    if (Number.parseInt(DEC.decode(chunk).trim() || '0', 10) > 0) anyMatch = true
    yield chunk
  }
  if (!anyMatch) io.exitCode = 1
}

export interface GrepStreamOptions {
  invert: boolean
  lineNumbers: boolean
  onlyMatching: boolean
  maxCount: number | null
  countOnly: boolean
  afterContext: number
  beforeContext: number
}

export async function* grepStream(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  opts: GrepStreamOptions,
): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: false })
  const hasContext = opts.afterContext > 0 || opts.beforeContext > 0
  if (hasContext && !opts.countOnly && !opts.onlyMatching) {
    const allLines: string[] = []
    const iter = new AsyncLineIterator(source)
    for await (const raw of iter) allLines.push(dec.decode(raw))
    for (const chunk of grepContextLines(
      allLines,
      pat,
      opts.invert,
      opts.lineNumbers,
      opts.maxCount,
      opts.afterContext,
      opts.beforeContext,
    )) {
      yield chunk
    }
    return
  }
  let matchCount = 0
  let lineNum = 0
  const reGlobal = opts.onlyMatching
    ? new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')
    : null
  const iter = new AsyncLineIterator(source)
  for await (const rawLine of iter) {
    lineNum += 1
    const line = dec.decode(rawLine)
    const found = pat.test(line)
    const hit = opts.invert ? !found : found
    if (!hit) continue
    if (opts.onlyMatching && !opts.invert && reGlobal !== null) {
      reGlobal.lastIndex = 0
      for (;;) {
        const m = reGlobal.exec(line)
        if (m === null) break
        matchCount += 1
        if (!opts.countOnly) yield enc.encode(m[0] + '\n')
        if (opts.maxCount !== null && matchCount >= opts.maxCount) {
          if (opts.countOnly) yield enc.encode(String(matchCount) + '\n')
          return
        }
      }
    } else {
      matchCount += 1
      if (!opts.countOnly) {
        if (opts.lineNumbers) yield enc.encode(`${String(lineNum)}:${line}\n`)
        else {
          const out = new Uint8Array(rawLine.byteLength + 1)
          out.set(rawLine, 0)
          out[rawLine.byteLength] = 0x0a
          yield out
        }
      }
      if (opts.maxCount !== null && matchCount >= opts.maxCount) {
        if (opts.countOnly) yield enc.encode(String(matchCount) + '\n')
        return
      }
    }
  }
  if (opts.countOnly) yield enc.encode(String(matchCount) + '\n')
}

export interface GrepFilesOnlyOptions {
  recursive: boolean
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  wholeWord: boolean
  basic: boolean
}

export async function grepRecursive(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  compiled: RegExp,
  opts: GrepFilesOnlyOptions,
  warnings: string[] | null,
  filesOnly = true,
): Promise<string[]> {
  const lineOpts: GrepLinesOptions = {
    invert: opts.invert,
    lineNumbers: opts.lineNumbers,
    countOnly: opts.countOnly,
    filesOnly,
    onlyMatching: opts.onlyMatching,
    maxCount: opts.maxCount,
  }
  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null)
      warnings.push(`grep: ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return results
  }
  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null)
        warnings.push(`grep: ${entry}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (s.type === FileType.DIRECTORY) {
      const sub = await grepRecursive(
        readdirFn,
        statFn,
        readBytesFn,
        entry,
        compiled,
        opts,
        warnings,
        filesOnly,
      )
      for (const r of sub) results.push(r)
      continue
    }
    if (BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    try {
      const lines = new TextDecoder('utf-8', { fatal: false })
        .decode(await readBytesFn(entry))
        .split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const fileResults = grepLines(entry, lines, compiled, lineOpts)
      if (opts.countOnly) {
        if (fileResults.length > 0) results.push(`${entry}:${fileResults[0] ?? ''}`)
      } else if (filesOnly) {
        for (const r of fileResults) results.push(r)
      } else {
        for (const r of fileResults) results.push(`${entry}:${r}`)
      }
    } catch (err) {
      if (warnings !== null)
        warnings.push(`grep: ${entry}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return results
}

// The exit status grep and ripgrep share. An operand the search could not read
// is exit 2, and it outranks a match: both tools print the lines they did find
// and still exit 2. The one exception is grep's -q, documented as exiting zero
// when a match is found "even if an error was detected". Everything else is the
// familiar 0 for a match, 1 for none.
export function exitCodeFor(matched: boolean, failed: boolean, quiet: boolean): number {
  if (matched && quiet) return 0
  if (failed) return 2
  return matched ? 0 : 1
}

// Whether an operand names a directory, asked on both channels. Both are
// consulted because on a prefix store a directory is the set of keys under it
// rather than an object, so stat misses one that readdir lists happily. The
// listing has to be non-empty to count: such a store answers readdir for any
// path at all, returning nothing for one that does not exist, so a bare "it did
// not throw" reads every missing file as a directory. The cost is that a
// genuinely empty directory is invisible there, which is the same thing `du`
// already documents and the safer way round: naming a missing file is a report
// a caller can act on, calling it a directory is not.
async function operandIsDirectory(
  readdirFn: AsyncReaddirFn,
  info: FileStat | null,
  path: string,
): Promise<boolean> {
  if (info !== null) return info.type === FileType.DIRECTORY
  try {
    return (await readdirFn(path)).length > 0
  } catch {
    return false
  }
}

// GNU's stderr line for an operand grep could not read. A directory does not
// reach here: it is recognized from its type before the read, because what a
// read throws for one is whatever the backend happens to do about it.
function operandError(path: string, err: unknown): string {
  if (isMissingPath(err)) return `grep: ${path}: No such file or directory`
  return `grep: ${path}: ${err instanceof Error ? err.message : String(err)}`
}

export async function grepFilesOnly(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  pattern: string,
  opts: GrepFilesOnlyOptions,
  warnings: string[] | null = null,
): Promise<string[]> {
  const compiled = compilePattern(
    pattern,
    opts.ignoreCase,
    opts.fixedString,
    opts.wholeWord,
    opts.basic,
  )
  // What the operand is, asked before it is read. A failed read is a
  // backend-dependent proxy for the type and a poor one: a keyed store reads a
  // directory path without complaint and returns nothing, and ssh answers with
  // an SFTP error that is not a filesystem error at all, so classifying
  // afterwards gets a different answer per backend.
  let info: FileStat | null = null
  try {
    info = await statFn(path)
  } catch {
    info = null
  }
  if (opts.recursive) {
    // GNU only walks directory operands; a file operand under -r takes the
    // plain single-file scan (python grep_files_only parity). Stat failures
    // keep the walk so missing operands surface its error shape.
    const operandIsFile = info !== null && info.type !== FileType.DIRECTORY
    if (!operandIsFile) {
      return grepRecursive(readdirFn, statFn, readBytesFn, path, compiled, opts, warnings)
    }
  }
  // GNU names a directory operand and moves on without descending into it; only
  // -r walks one, and that branch returned above. Walking here would make -l
  // alone behave like -rl.
  if (await operandIsDirectory(readdirFn, info, path)) {
    if (warnings !== null) warnings.push(`grep: ${path}: Is a directory`)
    return []
  }
  let data: Uint8Array
  try {
    data = await readBytesFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(operandError(path, err))
    return []
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let count = 0
  for (const line of lines) {
    const found = compiled.test(line)
    const matched = opts.invert ? !found : found
    if (matched) {
      count += 1
      if (opts.maxCount !== null && count >= opts.maxCount) break
    }
  }
  if (opts.countOnly) return [String(count)]
  return count > 0 ? [path] : []
}

// Prefix every line chunk with a filename label (grep -H). The grep stream
// yields one line per chunk, so a per-chunk prefix is a per-line prefix.
export async function* prefixLines(
  source: AsyncIterable<Uint8Array>,
  prefix: string,
): AsyncIterable<Uint8Array> {
  const encoded = new TextEncoder().encode(prefix)
  for await (const chunk of source) {
    const out = new Uint8Array(encoded.byteLength + chunk.byteLength)
    out.set(encoded, 0)
    out.set(chunk, encoded.byteLength)
    yield out
  }
}
