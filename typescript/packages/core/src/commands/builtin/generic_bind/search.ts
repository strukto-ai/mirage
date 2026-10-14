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
import { activeCacheManager } from '../../../cache/context.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'

import { closeQuietly, ensureStream } from '../../../io/stream.ts'
import type { ByteSource } from '../../../io/types.ts'
import { byteView, utf8Locale } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'
import { bomOf } from '../../../utils/encoding.ts'
import { BINARY_EXTENSIONS, getExtension } from '../../../utils/filetype.ts'
import { CycleError, globPrefixMatch } from '../../../utils/path.ts'
import { isFsError } from '../../../errors/fs.ts'
import { revisionFor } from '../../../observe/context.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import type { CommandOpts, CommandIO } from '../../config.ts'
import type { LinkView } from '../../../view/types.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'

import { directoriesAction, parseFlags as parseGrepFlags } from '../generic/grep.ts'
import { encodingFlag, foldsCase, parseFlags as parseRgFlags, rgMatcher } from '../generic/rg.ts'
import { searchTerms } from '../grep_pushdown.ts'
import { compilePattern, patternArg } from '../grep_pattern.ts'
import type { SearchTerms } from '../types.ts'
import { beforeFullScan } from '../utils/tree.ts'

type Reads = (p: PathSpec) => AsyncIterable<Uint8Array>

/**
 * What a grep line asks the mount's search; null when it must read every
 * file: -v, -f, or no plain text of three characters every match holds (under
 * -i, a word with a non-ASCII letter, or with i, k or s when case folds by
 * Unicode, counts as none). Throws the refusal grep itself would print for a
 * bad flag or pattern. Mirrors Python's `grep_terms`.
 */
export function grepTerms(
  bag: Record<string, FlagValue>,
  texts: string[],
  utf8: boolean,
): SearchTerms | null {
  const fl = new FlagView(bag, specOf('grep'))
  const f = parseGrepFlags(fl)
  const pattern = patternArg(texts, bag)
  if (f.invert) return null
  if (pattern === null || fl.raw('file') !== undefined) return null
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
  if (found === null) return null
  return {
    texts: found[0],
    wholeWord: found[1],
    ignoreCase: f.ignoreCase,
    lineOutput: !(
      f.lineNumbers ||
      f.byteOffsets ||
      f.afterContext !== null ||
      f.beforeContext !== null ||
      f.nullData === true
    ),
    readsBinary: f.filters.text,
  }
}

/**
 * What an rg line asks the mount's search; null when it must read every file:
 * -v or --passthru, a listing of files that do not match
 * (--files-without-match, -c or --count-matches with --include-zero, without
 * -q; --stats, --json), -L, -z, --pre, -E naming an encoding, -f, or no plain
 * text every match holds. Throws the refusal rg itself would print for a bad
 * flag or pattern. Mirrors Python's `rg_terms`.
 */
export function rgTerms(bag: Record<string, FlagValue>, texts: string[]): SearchTerms | null {
  const fl = new FlagView(bag, specOf('rg'))
  const f = parseRgFlags(fl)
  const pattern = patternArg(texts, bag)
  if (f.invert || f.passthru) return null
  if (!f.quiet && (f.filesWithoutMatch || (f.includeZero && (f.countOnly || f.countMatches)))) {
    return null
  }
  if (f.stats === true || f.json === true) return null
  if (f.follow) return null
  if (
    f.searchZip === true ||
    (f.pre ?? null) !== null ||
    !['auto', 'none'].includes(f.encoding ?? 'auto')
  ) {
    return null
  }
  if (pattern === null || fl.raw('file') !== undefined) return null
  const ignoreCase = foldsCase(pattern, f.fixedString, f)
  const found = searchTerms(
    pattern,
    rgMatcher(pattern, false, f),
    f.fixedString,
    f.wholeWord,
    f.lineRegexp,
    ignoreCase,
  )
  // -U matches across lines, so a text with a line break in it is no line's
  // to find.
  if (found === null || (f.multiline === true && found[0].some((text) => text.includes('\n'))))
    return null
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
      f.nullData ||
      f.multiline === true
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

/**
 * rg's `linesContaining` answer as it stands, or null, so the file is read,
 * when it starts with a byte-order mark: rg drops a mark only where the file
 * starts, which an answer cannot say it does. Under `-E none` rg keeps the
 * mark, so its answer is not asked here. Mirrors Python's `_unmarked`.
 */
async function unmarked(found: ByteSource): Promise<ByteSource | null> {
  if (found instanceof Uint8Array) return bomOf(found) === null ? found : null
  const rest = found[Symbol.asyncIterator]()
  let head: Uint8Array = new Uint8Array(0)
  while (head.length < 3) {
    const step = await rest.next()
    if (step.done === true) break
    head = concat([head, step.value])
  }
  if (bomOf(head) !== null) {
    await closeQuietly(found)
    return null
  }
  return replayed(head, rest)
}

async function* replayed(
  head: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    if (head.length > 0) yield head
    for (let step = await rest.next(); step.done !== true; step = await rest.next()) {
      yield step.value
    }
  } finally {
    await rest.return?.()
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

// Let each walked directory's mount refuse a walk that reads every file; the
// dispatcher passes over a path that is not a directory.
/**
 * Whether a link leads `virtual` elsewhere, at its name or above it. A mount's
 * search sees only what its backend holds, never a link, so it can judge no
 * such path. Mirrors Python's `_linked`.
 */
function linked(links: LinkView | undefined, virtual: string): boolean {
  if (links === undefined) return false
  try {
    return links.resolve(virtual) !== virtual
  } catch (err) {
    if (err instanceof CycleError) return true
    throw err
  }
}

async function fullScan(
  dispatch: CommandOpts['dispatch'],
  dirs: PathSpec[],
  name: string,
): Promise<void> {
  for (const scope of dirs) await beforeFullScan(dispatch, scope, name)
}

/**
 * grep's or rg's reads, narrowed by the mount's search where it can.
 * `filesContaining` rules out walked files no match can be in, of those the
 * mount's `searchable` names, and `linesContaining` hands a file's matching
 * lines in its place when the output shows nothing else, or tells whether it
 * is worth reading. An operand
 * named on the line is never ruled out by a search asked about directories,
 * nor is a path pinned to a revision, since a search sees the current content,
 * nor a file the read cache holds, which a read serves as it was cached, nor a
 * path a link leads elsewhere, which the mount's search never sees.
 * Both are asked through the dispatcher, which drops what the session hides
 * from a `filesContaining` answer, judges `linesContaining` as a read of its
 * file, and answers null where a path rule or a preVfs policy reaches below a
 * directory, so every file is read and judged.
 * When neither can stand in for a walk, the mount's `beforeFullScan` may
 * refuse it.
 * Mirrors Python's `search_reads`.
 */
export async function searchReads<A extends Accessor>(
  io: CommandIO<A>,
  name: 'grep' | 'rg',
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<Reads> {
  const index = opts.index ?? undefined
  const stream: Reads = (p) => io.readStream(accessor, p, index)
  const files = io.filesContaining
  const searchable = io.searchable ?? null
  const lines = io.linesContaining
  const links = opts.ns?.links
  const fl = new FlagView(opts.flags, specOf(name))
  if (paths.length === 0 || (name === 'rg' && (fl.asBool('files') || fl.asBool('type_list')))) {
    return stream
  }
  const walked = name === 'rg' || directoriesAction(fl) === 'recurse'
  if (files === undefined && lines === undefined) {
    if (walked) await fullScan(opts.dispatch, paths, name)
    return stream
  }
  let terms: SearchTerms | null
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
  const dirs = walked ? await directories(io, accessor, paths, index) : []
  if (terms === null) {
    await fullScan(opts.dispatch, dirs, name)
    return stream
  }
  const asked = terms
  const dropsMark = name === 'rg' && encodingFlag(fl) !== 'none'
  let hits: Set<string> | null = null
  if (files !== undefined && dirs.length > 0) {
    const answers = await Promise.all(
      dirs.flatMap((scope) =>
        asked.texts.map((text) =>
          files(
            accessor,
            scope,
            text,
            { wholeWord: asked.wholeWord, ignoreCase: asked.ignoreCase },
            index,
          ),
        ),
      ),
    )
    if (answers.every((answer) => answer !== null)) {
      hits = new Set(answers.flatMap((answer) => answer.map((hit) => hit.vfsPath.toLowerCase())))
    }
  }
  if (hits === null && lines === undefined) {
    await fullScan(opts.dispatch, dirs, name)
    return stream
  }
  if (hits !== null && asked.readsBinary) {
    await fullScan(opts.dispatch, dirs, name)
  }
  const dirNames = new Set(dirs.map((p) => p.virtual))
  const named = new Set(paths.map((p) => p.virtual).filter((v) => !dirNames.has(v)))
  const found = hits
  // Asked once; a refusal then stands for every file no search answered.
  let scan: Promise<void> | null = null
  const readUnanswered = (): Promise<void> => {
    if (found !== null) return Promise.resolve()
    scan ??= fullScan(opts.dispatch, dirs, name)
    return scan
  }
  const narrowed = async (path: PathSpec): Promise<ByteSource | null> => {
    const manager = activeCacheManager()
    if (manager !== null && (await manager.isCached(path))) return null
    if (linked(links, path.virtual)) return null
    if (
      found !== null &&
      !named.has(path.virtual) &&
      revisionFor(path.virtual) === null &&
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
      const found = await lines(accessor, path, only, ignoreCase, index)
      const answer = found !== null && dropsMark ? await unmarked(found) : found
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
