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

import type { Accessor } from '../../../accessor/base.ts'
import { pathsScoped } from '../../../view/namespace_view.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'

import { ScanReason, type SearchQuery } from '../../../vfs/types.ts'
import { ensureStream } from '../../../io/stream.ts'
import { type ByteSource, IOResult } from '../../../io/types.ts'
import { byteView, utf8Locale } from '../../../shell/bytes.ts'
import { BINARY_EXTENSIONS, getExtension } from '../../../utils/filetype.ts'
import { globPrefixMatch } from '../../../utils/path.ts'
import { isEfbig, isFsError } from '../../../errors/fs.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts, CommandIO } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'

import { grepGeneric, parseFlags as parseGrepFlags } from '../generic/grep.ts'
import {
  foldsCase,
  parseFlags as parseRgFlags,
  rgGeneric,
  rgMatcher,
  rgSyntax,
} from '../generic/rg.ts'
import {
  grepSearchMeta,
  textSearchResults,
  literalPushdownOperand,
  pushdownOperand,
  searchTerms,
} from '../grep_pushdown.ts'
import { PATTERN_KEYS, compilePattern, matcherSyntax, patternArg } from '../grep_pattern.ts'
import type { SearchTerms } from '../types.ts'
import { formatRecords } from '../utils/output.ts'
import { resolveGlobOf } from './adapter.ts'

type GenericScan = (
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stat: (p: PathSpec) => Promise<FileStat>,
  readdir: (p: PathSpec) => Promise<string[]>,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
) => Promise<CommandFnResult>

const GENERICS: Record<string, GenericScan> = {
  grep: (paths, texts, opts, stat, readdir, stream) =>
    grepGeneric('grep', paths, texts, opts, stat, readdir, stream),
  rg: rgGeneric,
}

async function* bytesStream<A extends Accessor>(
  io: CommandIO<A>,
  accessor: A,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await io.readBytes(accessor, p, index)
}

// A native stream may serve only some kinds (mongodb streams documents.jsonl
// and refuses schema.json before yielding anything), so a first-pull failure
// falls back to the whole read; an error after data has flowed is real and
// propagates. Mirrors the python generic, which streams only where the
// backend can serve and reads bytes everywhere else.
async function* nativeOrBytes<A extends Accessor>(
  io: CommandIO<A>,
  accessor: A,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const it = io.readStream(accessor, p, index)[Symbol.asyncIterator]()
  let first: IteratorResult<Uint8Array>
  try {
    first = await it.next()
  } catch {
    yield await io.readBytes(accessor, p, index)
    return
  }
  while (!first.done) {
    yield first.value
    first = await it.next()
  }
}

type Reads = (p: PathSpec) => AsyncIterable<Uint8Array>

/**
 * What a grep line asks the mount's search, or why it cannot ask. Throws the
 * refusal grep itself would print for a bad flag or pattern. Mirrors Python's
 * `grep_terms`.
 */
export function grepTerms(
  bag: Record<string, FlagValue>,
  texts: string[],
  utf8: boolean,
): SearchTerms | ScanReason {
  const fl = new FlagView(bag, specOf('grep'))
  const f = parseGrepFlags(fl)
  const pattern = patternArg(texts, bag, PATTERN_KEYS.grep)
  if (f.invert) return ScanReason.EVERY_LINE
  if (pattern === null || fl.raw('file') !== undefined) return ScanReason.NO_TEXT
  const matcher = compilePattern(
    byteView(pattern, utf8),
    f.ignoreCase,
    f.fixedString,
    f.wholeWord,
    f.syntax,
    utf8,
    f.lineRegexp,
  )
  const found = searchTerms(
    pattern,
    matcher,
    f.fixedString,
    f.wholeWord,
    f.lineRegexp,
    f.ignoreCase,
  )
  if (found === null) return ScanReason.NO_TEXT
  return {
    texts: found[0],
    wholeWord: found[1],
    ignoreCase: f.ignoreCase,
    lineOutput: !(f.lineNumbers || f.byteOffsets || f.afterContext > 0 || f.beforeContext > 0),
    readsBinary: f.filters.text,
  }
}

/**
 * What an rg line asks the mount's search, or why it cannot ask; null when the
 * line reads no file content (--files, --type-list). Throws the refusal rg
 * itself would print for a bad flag or pattern. Mirrors Python's `rg_terms`.
 */
export function rgTerms(
  bag: Record<string, FlagValue>,
  texts: string[],
): SearchTerms | ScanReason | null {
  const fl = new FlagView(bag, specOf('rg'))
  const f = parseRgFlags(fl)
  if (f.listFiles || f.typeList) return null
  const pattern = patternArg(texts, bag, PATTERN_KEYS.rg)
  if (f.invert || f.passthru) return ScanReason.EVERY_LINE
  if (!f.quiet && (f.filesWithoutMatch || (f.includeZero && (f.countOnly || f.countMatches)))) {
    return ScanReason.EVERY_FILE
  }
  if (f.follow) return ScanReason.LINKS
  if (pattern === null || fl.raw('file') !== undefined) return ScanReason.NO_TEXT
  const ignoreCase = foldsCase(pattern, f.fixedString, f)
  const found = searchTerms(
    pattern,
    rgMatcher(pattern, false, f),
    f.fixedString,
    f.wholeWord,
    f.lineRegexp,
    ignoreCase,
  )
  if (found === null) return ScanReason.NO_TEXT
  return {
    texts: found[0],
    wholeWord: found[1],
    ignoreCase,
    lineOutput: !(
      f.lineNumbers ||
      f.byteOffsets ||
      f.column ||
      f.vimgrep ||
      f.contextAfter > 0 ||
      f.contextBefore > 0 ||
      f.stopOnNonmatch ||
      f.nullData
    ),
    readsBinary: f.binary,
  }
}

/**
 * Reads that search what `narrowed` answers for a file. The walk still lists,
 * filters, orders and labels every file; a file `narrowed` answers empty
 * prints exactly what one with no match would (-c counts 0, -L lists it), one
 * it answers with lines is searched over them, and null reads the file.
 * Mirrors Python's `candidate_reads`.
 */
export function candidateReads(
  stream: Reads,
  narrowed: (p: PathSpec) => Promise<ByteSource | null>,
): Reads {
  return async function* (p: PathSpec): AsyncIterable<Uint8Array> {
    const data = await narrowed(p)
    for await (const chunk of data === null ? stream(p) : ensureStream(data)) {
      if (chunk.length > 0) yield chunk
    }
  }
}

// Whether a `linesContaining` answer holds a line; a stream is pulled to its
// first non-empty chunk and closed.
async function holdsLine(found: ByteSource): Promise<boolean> {
  if (found instanceof Uint8Array) return found.length > 0
  for await (const chunk of found) {
    if (chunk.length > 0) return true
  }
  return false
}

// The operands that stat as directories, the scopes a walk covers.
async function directories<A extends Accessor>(
  io: CommandIO<A>,
  accessor: A,
  paths: readonly PathSpec[],
  index: IndexCacheStore | undefined,
): Promise<PathSpec[]> {
  const found: PathSpec[] = []
  for (const path of paths) {
    let info: FileStat
    try {
      info = await io.stat(accessor, path, index)
    } catch (err) {
      if (!isFsError(err)) throw err
      console.debug(`search scope ${path.virtual}: ${String(err)}`)
      continue
    }
    if (info.type === FileType.DIRECTORY) found.push(path)
  }
  return found
}

// Let the mount refuse a walk that will read every file.
async function fullScan<A extends Accessor>(
  io: CommandIO<A>,
  name: string,
  accessor: A,
  dirs: PathSpec[],
  reason: ScanReason,
  index: IndexCacheStore | undefined,
): Promise<void> {
  if (dirs.length > 0 && io.beforeFullScan !== undefined) {
    await io.beforeFullScan(accessor, name, dirs, reason, index)
  }
}

/**
 * grep's or rg's reads, narrowed by the mount's search where it can.
 * `filesContaining` rules out walked files no match can be in, of those the
 * mount's `searchable` names, and `linesContaining` hands a file's matching
 * lines in its place when the output shows nothing else, or tells whether it
 * is worth reading. An operand
 * named on the line is never ruled out by a search asked about directories.
 * Neither is asked when a hide, a path rule or a preVfs policy judges a path,
 * since a search sees the raw tree.
 * When neither can stand in for a walk, `beforeFullScan` may refuse it.
 * `read` is the plain stream narrowed, the mount's `readStream` by default.
 * Mirrors Python's `search_reads`.
 */
export async function searchReads<A extends Accessor>(
  io: CommandIO<A>,
  name: 'grep' | 'rg',
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  read?: Reads,
): Promise<Reads> {
  const index = opts.index ?? undefined
  const stream: Reads = read ?? ((p) => io.readStream(accessor, p, index))
  const scoped = pathsScoped(opts.ns, paths, opts.mountPrefix ?? '')
  const files = scoped ? undefined : io.filesContaining
  const searchable = io.searchable ?? null
  const lines = scoped ? undefined : io.linesContaining
  if (
    paths.length === 0 ||
    (files === undefined && lines === undefined && io.beforeFullScan === undefined)
  ) {
    return stream
  }
  let terms: SearchTerms | ScanReason | null
  try {
    terms =
      name === 'rg'
        ? rgTerms(opts.flags, texts)
        : grepTerms(opts.flags, texts, utf8Locale(opts.env))
  } catch (err) {
    if (!(err instanceof Error)) throw err
    console.debug(`${name} search left to the scan: ${err.message}`)
    return stream
  }
  if (terms === null) return stream
  const fl = new FlagView(opts.flags, specOf(name))
  const walked = name === 'rg' || fl.asBool('r') || fl.asBool('R')
  const dirs = walked ? await directories(io, accessor, paths, index) : []
  if (typeof terms === 'string') {
    await fullScan(io, name, accessor, dirs, terms, index)
    return stream
  }
  const asked = terms
  let hits: Set<string> | null = null
  if (files !== undefined && dirs.length > 0) {
    const answers = await Promise.all(
      asked.texts.map((text) =>
        files(
          accessor,
          text,
          dirs,
          { wholeWord: asked.wholeWord, ignoreCase: asked.ignoreCase },
          index,
        ),
      ),
    )
    if (answers.every((answer) => answer !== null)) {
      hits = new Set(answers.flatMap((answer) => answer.map((hit) => hit.vfsPath.toLowerCase())))
    }
  }
  if (hits === null && lines === undefined) {
    const reason = files === undefined ? ScanReason.NO_SEARCH : ScanReason.UNANSWERED
    await fullScan(io, name, accessor, dirs, reason, index)
    return stream
  }
  if (hits !== null && asked.readsBinary) {
    await fullScan(io, name, accessor, dirs, ScanReason.BINARY, index)
  }
  const dirNames = new Set(dirs.map((p) => p.virtual))
  const named = new Set(paths.map((p) => p.virtual).filter((v) => !dirNames.has(v)))
  const found = hits
  // Asked once; a refusal then stands for every file no search answered.
  let scan: Promise<void> | null = null
  const readUnanswered = (): Promise<void> => {
    if (found !== null) return Promise.resolve()
    scan ??= fullScan(io, name, accessor, dirs, ScanReason.UNANSWERED, index)
    return scan
  }
  const narrowed = async (path: PathSpec): Promise<ByteSource | null> => {
    if (
      found !== null &&
      !named.has(path.virtual) &&
      !(asked.readsBinary && BINARY_EXTENSIONS.has(getExtension(path.virtual) ?? '')) &&
      !found.has(path.vfsPath.toLowerCase()) &&
      (searchable === null || searchable.some((glob) => globPrefixMatch(path.vfsPath, glob)))
    ) {
      return new Uint8Array(0)
    }
    if (lines === undefined) return null
    const ignoreCase = { ignoreCase: asked.ignoreCase }
    const [only] = asked.texts
    if (asked.lineOutput && asked.texts.length === 1 && only !== undefined) {
      const answer = await lines(accessor, path, only, ignoreCase, index)
      if (answer === null) await readUnanswered()
      return answer
    }
    for (const text of asked.texts) {
      const answer = await lines(accessor, path, text, ignoreCase, index)
      if (answer === null) {
        await readUnanswered()
        return null
      }
      if (await holdsLine(answer)) return null
    }
    return new Uint8Array(0)
  }
  return candidateReads(stream, narrowed)
}

// How a native search matches the pushed-down pattern. `utf8` is grep under a
// UTF-8 locale; ripgrep matches text under any.
export function searchOptions(
  name: 'grep' | 'rg',
  fl: FlagView,
  pattern: string,
  utf8 = false,
): Record<string, boolean | string> {
  if (name === 'rg') {
    const f = parseRgFlags(fl)
    return {
      ignore_case: foldsCase(pattern, f.fixedString, f),
      fixed_string: f.fixedString,
      whole_word: f.wholeWord,
      syntax: rgSyntax(f),
    }
  }
  return {
    ignore_case: fl.asBool('i'),
    fixed_string: fl.asBool('F'),
    whole_word: fl.asBool('w'),
    syntax: matcherSyntax(fl),
    utf8,
  }
}

/**
 * Execute an adapter's qualified search, or scan for an unsupported request.
 * The scan reads through `searchReads`, so `filesContaining`,
 * `linesContaining` and `beforeFullScan` still apply.
 */
export async function runSearch<A extends Accessor>(
  io: CommandIO<A>,
  name: 'grep' | 'rg',
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const capability = io.search
  const meta = grepSearchMeta(capability)
  const fl = new FlagView(opts.flags, specOf(name))
  const pattern = patternArg(texts, opts.flags, PATTERN_KEYS[name])
  const gate = meta?.mode === 'literal' ? literalPushdownOperand : pushdownOperand
  const operand = gate(paths, opts.flags, pattern)
  if (
    capability !== undefined &&
    meta !== null &&
    pattern !== null &&
    operand !== null &&
    !pathsScoped(opts.ns, [operand])
  ) {
    const query: SearchQuery = {
      query: pattern,
      options: { grep: searchOptions(name, fl, pattern, utf8Locale(opts.env)) },
    }
    let lines: string[] | null
    try {
      lines = await capability.search(accessor, operand, query, opts.index ?? undefined)
    } catch (err) {
      // A push-down whose answer is past the mount's read cap cannot print
      // it; the scan reads each operand, and reports the same refusal against
      // the operand as typed.
      if (!isEfbig(err)) throw err
      lines = null
    }
    if (lines !== null) {
      if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
      if (name !== 'grep' || textSearchResults(lines)) return [formatRecords(lines), new IOResult()]
    }
  }
  const resolved =
    paths.length > 0 ? await resolveGlobOf(io)(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => io.stat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    io.readdir(accessor, p, opts.index ?? undefined)
  const stream = (p: PathSpec): AsyncIterable<Uint8Array> =>
    meta === null || meta.stream
      ? nativeOrBytes(io, accessor, p, opts.index ?? undefined)
      : bytesStream(io, accessor, p, opts.index ?? undefined)
  const reads = await searchReads(io, name, accessor, resolved, texts, opts, stream)
  const generic = GENERICS[name]
  if (generic === undefined) throw new Error(`runSearch: no generic for ${name}`)
  return generic(resolved, texts, opts, stat, readdir, reads)
}
