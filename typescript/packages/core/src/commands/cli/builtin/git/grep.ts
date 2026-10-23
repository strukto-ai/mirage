import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { concat } from '../../../../utils/bytes.ts'
import { IOResult } from '../../../../io/types.ts'
import { byteView, encodeText, fromByteView, utf8Locale } from '../../../../shell/bytes.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { RegexSyntax } from '../../../builtin/types.ts'
import { RegexError } from '../../../../rs/errors.ts'
import { posixEscape, posixRegex, type PosixRegex } from '../../../../rs/regex.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { mountsOf } from '../../../builtin/utils/links.ts'
import { requireWorkTree } from './discover.ts'
import {
  AmbiguousArgumentError,
  FATAL_EXIT,
  GitError,
  InvalidRevisionNameError,
  PatternCompileError,
  UsageError,
} from './errors.ts'
import { readIndex } from './index_file.ts'
import { exists, isLink, readOptional } from './io.ts'
import { pathspecPatterns, pathspecSelects, repoRelative } from './pathspec.ts'
import { quotePath, relativePath } from './render.ts'
import { EXECUTABLE, EXECUTABLE_MODE, REGULAR, REGULAR_MODE } from './constants.ts'
import { blobData } from './patch.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { BINARY_SNIFF } from './summary.ts'
import { resolveObject, unwrapped } from './revparse.ts'
import { placeNamed, shownEntries } from './seen.ts'
import { resolveTree, treeEntries, type TreeEntry } from './tree.ts'
import { checkSwitches, splitMarked, startPoint, verbUsage, requireVfs } from './util.ts'

/** A compiled search and presentation, independent of content source. */
interface GrepFlags {
  readonly patterns: readonly ((line: string) => boolean)[]
  readonly invert: boolean
  readonly numbers: boolean
  readonly count: boolean
  readonly listing: string
  readonly quiet: boolean
  readonly filename: boolean
  readonly nul: boolean
  readonly binary: string
  readonly utf8: boolean
}

// A line test for one pattern; under -w only a match that consumes something
// counts, so an empty match does not select the line. Mirrors Python's
// _line_matcher.
function lineMatcher(pattern: PosixRegex, nonempty: boolean): (line: string) => boolean {
  if (!nonempty) return (line) => pattern.search(line) !== null
  return (line) => pattern.all(line).some((span) => span[0] != null && span[0][0] !== span[0][1])
}

/** Compile patterns once, retaining Git's option precedence and errors. */
function parseFlags(
  fl: FlagView,
  patterns: readonly string[],
  origin: string,
  utf8: boolean,
): GrepFlags {
  let syntax = RegexSyntax.BASIC
  let fixed = false
  for (const [name] of fl.occurrences('basic_regexp', 'extended_regexp', 'fixed_strings')) {
    syntax = name === 'extended_regexp' ? RegexSyntax.EXTENDED : RegexSyntax.BASIC
    fixed = name === 'fixed_strings'
  }
  const ignoreCase = fl.asBool('ignore_case')
  const wholeWord = fl.asBool('word_regexp')
  const compiled: ((line: string) => boolean)[] = []
  for (const value of patterns) {
    for (const part of value.split('\n')) {
      const view = byteView(part, utf8)
      let pattern: PosixRegex
      try {
        pattern = posixRegex(
          fixed ? posixEscape(view) : view,
          fixed || syntax === RegexSyntax.EXTENDED,
          'posix',
          ignoreCase,
          utf8,
          false,
          wholeWord,
        )
      } catch (err) {
        if (err instanceof RegexError) throw new PatternCompileError(origin, part, err.message)
        throw err
      }
      compiled.push(lineMatcher(pattern, wholeWord))
    }
  }
  const listing = fl.asBool('files_without_match')
    ? 'files_without_match'
    : fl.asBool('files_with_matches')
      ? 'files_with_matches'
      : ''
  let filename = true
  for (const name of fl.typedOrder('h', 'H')) filename = name === 'H'
  let binary = 'binary'
  for (const name of fl.typedOrder('text', 'args_I')) binary = name === 'text' ? 'text' : 'skip'
  return {
    patterns: compiled,
    invert: fl.asBool('invert_match'),
    numbers: fl.asBool('line_number'),
    count: fl.asBool('count'),
    listing,
    quiet: fl.asBool('quiet'),
    filename,
    nul: fl.asBool('null'),
    binary,
    utf8,
  }
}

/** Select and render one file, preserving its content bytes. */
function searched(data: Uint8Array, label: string, flags: GrepFlags): [Uint8Array, boolean] {
  const binary = data.subarray(0, BINARY_SNIFF).includes(0) && flags.binary !== 'text'
  if (binary && flags.binary === 'skip') return [new Uint8Array(), false]
  const lines = byteView(data, flags.utf8).split('\n')
  if (lines.at(-1) === '') lines.pop()
  const selected: [number, string][] = []
  for (const [index, line] of lines.entries()) {
    if (flags.patterns.some((matches) => matches(line)) !== flags.invert)
      selected.push([index + 1, line])
  }
  const matched = selected.length > 0
  const found = flags.listing === 'files_without_match' ? !matched : matched
  if (!found || flags.quiet) return [new Uint8Array(), found]
  const sep = flags.nul ? '\0' : ':'
  if (flags.listing) return [encodeText(label + (flags.nul ? '\0' : '\n')), true]
  const prefix = flags.filename ? label + sep : ''
  if (flags.count) return [encodeText(prefix + String(selected.length) + '\n'), true]
  if (binary) return [encodeText(`Binary file ${label} matches\n`), true]
  return [
    concat(
      selected.flatMap(([lineNumber, line]) => [
        encodeText(prefix + (flags.numbers ? String(lineNumber) + sep : '')),
        fromByteView(line, flags.utf8),
        encodeText('\n'),
      ]),
    ),
    true,
  ]
}

/**
 * The searchable leaves of a tree-ish the session sees, keyed relative to it,
 * or a directly named blob.
 */
async function searchEntries(repo: Repo, name: string): Promise<Map<string, TreeEntry>> {
  const obj = await unwrapped(repo, await resolveObject(repo, name), name)
  if (obj.type === 'blob') return new Map([['', { mode: REGULAR_MODE, oid: obj.oid }]])
  const tree = await resolveTree(repo, name, obj)
  return shownEntries(repo, await treeEntries(repo, tree), await placeNamed(repo, name, tree))
}

/** Search tracked working files, index blobs, or named historical trees. */
export async function grep(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkSwitches(ctx, texts.slice(0, 1))
  let words = [...texts]
  let patterns = fl.asList('e')
  const origin = patterns.length ? '-e option' : 'command line'
  let paths: string[]
  let marked: boolean
  if (patterns.length) {
    ;[words, paths] = splitMarked(texts, ctx.argv ?? [])
    marked = (ctx.argv ?? []).includes('--')
    if (words.at(-1) === '--') words.pop()
  } else {
    const pattern = words.shift()
    if (pattern === undefined) {
      if (fl.asBool('h')) throw new UsageError(verbUsage(ctx), '')
      throw new GitError('no pattern given')
    }
    patterns = [pattern]
    marked = words.includes('--')
    const cut = marked ? words.indexOf('--') : words.length
    paths = words.slice(cut + 1)
    words = words.slice(0, cut)
  }
  const flags = parseFlags(fl, patterns, origin, utf8Locale(ctx.env))
  const repo = await opened(ctx, fl)
  const start = startPoint(fl).virtual
  const prefix = repoRelative(repo.location, start, '.')
  const cached = fl.asBool('cached')
  const sources: [string, Map<string, TreeEntry>][] = []
  for (const [index, word] of words.entries()) {
    if (word.startsWith('-'))
      throw new GitError(`option '${word}' must come before non-option arguments`)
    try {
      sources.push([word, await searchEntries(repo, word)])
    } catch (err) {
      if (!(err instanceof AmbiguousArgumentError || err instanceof InvalidRevisionNameError))
        throw err
      if (marked) throw new GitError(`unable to resolve revision: ${word}`)
      const relative = repoRelative(repo.location, start, word)
      if (!/[*?[]/.test(word) && !(await exists(repo.vfs, repo.location.worktree.join(relative))))
        throw new AmbiguousArgumentError(word)
      console.debug('Git grep operand is a pathspec:', word)
      paths = [...words.slice(index), ...paths]
      break
    }
  }
  if (sources.length && cached) throw new GitError('both --cached and trees are given')
  if (!sources.length && !cached) {
    await requireWorkTree(requireVfs(ctx), repo.location, fl.asPath('work_tree') !== undefined)
  }
  const specs = pathspecPatterns(repo.location, start, paths)
  if (!specs.length) specs.push(prefix)
  const fully = await configBool(repo, 'core.quotepath', true)
  if (!sources.length) {
    const state = await readIndex(repo, repo.vfs)
    const entries = new Map(
      [...state.entries].map(([path, entry]) => [
        path,
        { mode: entry.mode.toString(8), oid: entry.oid },
      ]),
    )
    if (!cached) {
      for (const [path, conflict] of state.conflicts) {
        for (const entry of [conflict.this, conflict.other, conflict.ancestor]) {
          if (entry !== null && [REGULAR, EXECUTABLE].includes(entry.mode)) {
            entries.set(path, { mode: entry.mode.toString(8), oid: entry.oid })
            break
          }
        }
      }
    }
    sources.push(['', shownEntries(repo, entries)])
  }
  const limit = mountsOf(ctx)?.fullScanLimit?.(repo.location.gitdir.virtual) ?? -1
  const out: Uint8Array[] = []
  let found = false
  let read = 0
  for (const [revision, entries] of sources) {
    for (const [path, entry] of [...entries].sort(([a], [b]) =>
      compareCodePoints(byteView(a), byteView(b)),
    )) {
      // Every source is what the session sees already, at the place its
      // tree stands.
      if (
        ![REGULAR_MODE, EXECUTABLE_MODE].includes(entry.mode) ||
        (path && !pathspecSelects(path, specs))
      )
        continue
      if (limit >= 0 && read >= limit) {
        // Past the mount's full_scan_limit the search stops, and what it
        // found so far stands, as git keeps what it printed before a fatal.
        return [
          concat(out),
          new IOResult({
            exitCode: FATAL_EXIT,
            stderr: encodeText(
              `fatal: stopped after ${String(limit)} files (full_scan_limit); narrow the pathspec\n`,
            ),
          }),
        ]
      }
      read += 1
      let data: Uint8Array | null
      if (revision || cached) data = await blobData(repo, entry)
      else {
        const target = repo.location.worktree.join(path)
        if (await isLink(repo.vfs, target)) continue
        data = await readOptional(repo.vfs, target)
        if (data === null) continue
      }
      let label = relativePath(path || revision, prefix)
      if (!flags.nul) label = quotePath(label, false, fully)
      if (revision && path) label = revision + ':' + label
      const [rendered, hit] = searched(data, label, flags)
      found ||= hit
      if (hit && flags.quiet) return [null, new IOResult()]
      out.push(rendered)
    }
  }
  return [concat(out), new IOResult({ exitCode: found ? 0 : 1 })]
}
