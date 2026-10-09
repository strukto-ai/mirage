import { concat } from '../../../../io/cachable_iterator.ts'
import { IOResult } from '../../../../io/types.ts'
import { byteView, encodeText, fromByteView, utf8Locale } from '../../../../shell/bytes.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { compilePosixRegex, posixLineMatcher } from '../../../../utils/posix.ts'
import { compilePattern } from '../../../builtin/grep_pattern.ts'
import { RegexSyntax } from '../../../builtin/types.ts'
import { BreError, PosixSyntax, translateEre } from '../../../builtin/utils/bre.ts'
import type { CommandFnResult } from '../../../config.ts'
import { UsageError as PatternError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { requireWorkTree } from './discover.ts'
import {
  NoWorkspaceError,
  AmbiguousArgumentError,
  GitError,
  InvalidRevisionNameError,
  UsageError,
} from './errors.ts'
import { readIndex } from './index_file.ts'
import { exists, readOptional } from './io.ts'
import { pathspecPatterns, pathspecSelects, repoRelative, visiblePath } from './pathspec.ts'
import { quotePath, relativePath } from './render.ts'
import { blobData } from './patch.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { BINARY_SNIFF } from './summary.ts'
import { resolveObject, unwrapped } from './revparse.ts'
import { resolveTree, treeEntries, type TreeEntry } from './tree.ts'
import { checkSwitches, fatal, splitMarked, startPoint, verbUsage } from './util.ts'

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
      try {
        let pattern =
          syntax === RegexSyntax.EXTENDED && !fixed
            ? compilePosixRegex(
                translateEre(byteView(part, utf8), PosixSyntax.EXTENDED)[0],
                ignoreCase ? 'i' : '',
                utf8,
              )
            : compilePattern(byteView(part, utf8), ignoreCase, fixed, false, syntax, utf8)
        if (wholeWord)
          pattern = compilePosixRegex(`(?<!\\w)(?:${pattern.source})(?!\\w)`, pattern.flags, utf8)
        compiled.push(posixLineMatcher(pattern, wholeWord))
      } catch (err) {
        if (err instanceof PatternError || err instanceof BreError || err instanceof SyntaxError)
          throw new GitError(`${origin}, '${part}': ${err.message.replace(/^grep: /, '')}`)
        throw err
      }
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

/** The searchable leaves of a tree-ish, or a directly named blob. */
async function searchEntries(repo: Repo, name: string): Promise<Map<string, TreeEntry>> {
  const obj = await unwrapped(repo, await resolveObject(repo, name), name)
  if (obj.type === 'blob') return new Map([['', { mode: '100644', oid: obj.oid }]])
  return treeEntries(repo, await resolveTree(repo, name, obj))
}

/** Search tracked working files, index blobs, or named historical trees. */
export async function grep(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    checkSwitches(inv, inv.texts.slice(0, 1))
    let words = [...inv.texts]
    let patterns = fl.asList('e')
    const origin = patterns.length ? '-e option' : 'command line'
    let paths: string[]
    let marked: boolean
    if (patterns.length) {
      ;[words, paths] = splitMarked(inv.texts, inv.argv)
      marked = inv.argv.includes('--')
      if (words.at(-1) === '--') words.pop()
    } else {
      const pattern = words.shift()
      if (pattern === undefined) {
        if (fl.asBool('h')) throw new UsageError(verbUsage(inv), '')
        throw new GitError('no pattern given')
      }
      patterns = [pattern]
      marked = words.includes('--')
      const cut = marked ? words.indexOf('--') : words.length
      paths = words.slice(cut + 1)
      words = words.slice(0, cut)
    }
    const flags = parseFlags(fl, patterns, origin, utf8Locale(inv.env))
    const doors = inv.doors ?? {}
    const repo = await opened(fl, doors)
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
        if (
          !/[*?[]/.test(word) &&
          !(await exists(repo.dispatch, repo.location.worktree.join(relative)))
        )
          throw new AmbiguousArgumentError(word)
        console.debug('Git grep operand is a pathspec:', word)
        paths = [...words.slice(index), ...paths]
        break
      }
    }
    if (sources.length && cached) throw new GitError('both --cached and trees are given')
    if (!sources.length && !cached) {
      if (doors.statPath === undefined) throw new NoWorkspaceError()
      await requireWorkTree(
        repo.dispatch,
        doors.statPath,
        repo.location,
        fl.asPath('work_tree') !== undefined,
      )
    }
    const specs = pathspecPatterns(repo.location, start, paths)
    if (!specs.length) specs.push(prefix)
    const fully = await configBool(repo, 'core.quotepath', true)
    if (!sources.length) {
      const state = await readIndex(repo, repo.dispatch)
      const entries = new Map(
        [...state.entries].map(([path, entry]) => [
          path,
          { mode: entry.mode.toString(8), oid: entry.oid },
        ]),
      )
      if (!cached) {
        for (const [path, conflict] of state.conflicts) {
          for (const entry of [conflict.this, conflict.other, conflict.ancestor]) {
            if (entry !== null && [0o100644, 0o100755].includes(entry.mode)) {
              entries.set(path, { mode: entry.mode.toString(8), oid: entry.oid })
              break
            }
          }
        }
      }
      sources.push(['', entries])
    }
    const out: Uint8Array[] = []
    let found = false
    for (const [revision, entries] of sources) {
      for (const [path, entry] of [...entries].sort(([a], [b]) =>
        compareCodePoints(byteView(a), byteView(b)),
      )) {
        if (
          !['100644', '100755'].includes(entry.mode) ||
          (path && (!visiblePath(repo.location, path) || !pathspecSelects(path, specs)))
        )
          continue
        let data: Uint8Array | null
        if (revision || cached) data = await blobData(repo, entry)
        else {
          const target = repo.location.worktree.join(path)
          if (repo.location.ns?.links?.statAt(target.virtual)) continue
          data = await readOptional(repo.dispatch, target)
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
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
