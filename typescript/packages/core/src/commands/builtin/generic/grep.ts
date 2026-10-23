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

import { byteView, utf8Locale } from '../../../shell/bytes.ts'
import { isStdin, operandLabel } from '../utils/stream.ts'
import { stdinStream, stdinStat } from '../utils/stream.ts'
import { guardInput } from '../utils/limit.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { fsStrerror, isFsError, isWalkError, walkRefusal } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { followedStat } from '../../../view/namespace_view.ts'
import { respellOne } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { mountParentReaddir, mountParentStat, toPathspec } from '../utils/wrap.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { concat } from '../../../utils/bytes.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import {
  NEVER_MATCH,
  compilePerl,
  type LineMatcher,
  matcherSyntax,
  patternWarnings,
  resolvePattern,
} from '../grep_pattern.ts'
import { exitCodeFor } from '../grep_scan.ts'
import { BINARY_EXTENSIONS, getExtension } from '../../../utils/filetype.ts'
import { Worker } from '../../../concurrency/worker.ts'
import { grepInput, nameEnd, type FlagSet } from '../grep_binary.ts'
import { openGrep, streamConfig, streamInput } from '../grep_stream.ts'
import { RegexSyntax } from '../types.ts'
import { OutputStream } from '../../../io/stream.ts'
import type { OpenStream } from '../../../rs/stream.ts'
import { fileAdmitted, dirAdmitted, parseFileGlobs } from '../grep_select.ts'
import { resolveSource } from '../utils/stream.ts'
import { ScanLimitError, UsageError } from '../../errors.ts'
import { SYNOPSES } from '../../spec/synopsis.ts'
import { wordRefusalLine, validWordsBlock, usageHint } from '../../spec/usage.ts'
import { matchWord } from '../../spec/word_choice.ts'
import { GREP_STDIN_LABEL } from '../utils/constants.ts'
import { linksOf, mountsOf, mountRoot } from '../utils/links.ts'

const ENC = new TextEncoder()
// GNU grep with no pattern prints its synopsis and the help hint, exit 2
// (grep 3.11; the same two lines follow `option requires an argument`).
const GREP_NO_PATTERN = `Usage: ${SYNOPSES.grep ?? ''}\n${usageHint('grep')}`
// What --directories takes; an unambiguous prefix names one too.
const DIRECTORIES = ['read', 'recurse', 'skip']
const DEVICES = ['read', 'skip']
// The types -D skip passes over; stdin is read whatever it is.
const DEVICE_TYPES: ReadonlySet<FileType> = new Set([
  FileType.CHAR_DEVICE,
  FileType.BLOCK_DEVICE,
  FileType.FIFO,
  FileType.SOCKET,
])
const UNIX_BYTE_OFFSETS = 'grep: warning: --unix-byte-offsets (-u) is obsolete\n'
// What GNU takes as -m's count: blanks, a sign, then digits.
const MAX_COUNT = /^[ \t\n\v\f\r]*[+-]?[0-9]+$/
type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function binaryMode(fl: FlagView): string {
  let mode = 'binary'
  for (const name of fl.typedOrder('text', 'args_I', 'binary_files')) {
    if (name === 'text' && fl.asBool('text')) mode = 'text'
    else if (name === 'args_I' && fl.asBool('args_I')) mode = 'without-match'
    else if (name === 'binary_files') {
      mode = fl.asStr('binary_files') ?? 'binary'
      if (!['binary', 'text', 'without-match'].includes(mode))
        throw new UsageError('grep: unknown binary-files type')
    }
  }
  return mode
}

/**
 * What grep does with a directory: read, recurse or skip. -r and -R are
 * --directories=recurse, so the last of the three on the line wins (grep
 * 3.11: `grep -r -d skip` skips, `-d skip -r` recurses). A word that names
 * none of the three, whole or as a prefix, comes back as typed;
 * `checkActions` refuses it.
 */
export function directoriesAction(fl: FlagView): string {
  let action = 'read'
  for (const name of fl.typedOrder('recursive', 'dereference_recursive', 'directories')) {
    if (name !== 'directories') {
      if (fl.asBool(name)) action = 'recurse'
      continue
    }
    const word = fl.asStr(name) ?? ''
    const match = matchWord(word, DIRECTORIES)
    action = match.matched ? match.word : word
  }
  return action
}

/**
 * Refuse a -d or -D word as GNU does, each one typed and not only the last:
 * its option loop stops at the first bad one. A -d word that names no action,
 * whole or as a prefix, gets GNU's invalid or ambiguous argument message, the
 * valid words and grep's usage, exit 1; -D takes only the exact words, exit 2.
 */
function checkActions(fl: FlagView): void {
  for (const [name, value] of fl.occurrences('directories', 'devices')) {
    const word = String(value)
    if (name === 'devices') {
      if (!DEVICES.includes(word)) throw new UsageError('grep: unknown devices method')
      continue
    }
    const match = matchWord(word, DIRECTORIES)
    if (!match.matched)
      throw new UsageError(
        `${wordRefusalLine('grep', '--directories', word, match.kind)}\n` +
          `${validWordsBlock(DIRECTORIES)}\n${GREP_NO_PATTERN}`,
        1,
      )
  }
}

/**
 * The line between context groups; null under --no-group-separator. The two
 * options set one variable, so the later one wins.
 */
function groupSeparator(fl: FlagView): string | null {
  let separator: string | null = '--'
  for (const name of fl.typedOrder('group_separator', 'no_group_separator')) {
    if (name === 'group_separator') separator = fl.asStr(name) ?? ''
    else if (fl.asBool(name)) separator = null
  }
  return separator
}

/** -i (or -y) unless a later --no-ignore-case turns it off. */
function ignoresCase(fl: FlagView): boolean {
  const names = fl.typedOrder('ignore_case', 'no_ignore_case').filter((name) => fl.asBool(name))
  return names[names.length - 1] === 'ignore_case'
}

/**
 * What grep warns once for the line, before it reads a file: an obsolete -u,
 * then the pattern's compile-time warnings. Mirrors Python's `line_warnings`.
 */
export function lineWarnings(fl: FlagView, matcher: LineMatcher | null): string {
  return (
    (fl.asBool('unix_byte_offsets') ? UNIX_BYTE_OFFSETS : '') +
    (matcher === null ? '' : patternWarnings(matcher))
  )
}

/** One -A/-B/-C value, refused the way GNU refuses it. */
function contextLength(fl: FlagView, name: string): number | undefined {
  const raw = fl.asStr(name)
  let value: number | undefined
  try {
    value = fl.asInt(name)
  } catch {
    throw new UsageError(`grep: ${raw ?? ''}: invalid context length argument`)
  }
  if (value !== undefined && value < 0) {
    throw new UsageError(`grep: ${raw ?? String(value)}: invalid context length argument`)
  }
  return value
}

/**
 * -m as GNU 3.11 reads it: leading blanks and a sign are allowed, a negative
 * count is no limit, and anything else is refused.
 */
export function maxCount(fl: FlagView): number | null {
  const raw = fl.asStr('max_count')
  if (raw !== undefined && !MAX_COUNT.test(raw)) throw new UsageError('grep: invalid max count')
  const count = raw === undefined ? fl.asInt('max_count') : Number(raw.trim())
  return count === undefined || count < 0 ? null : count
}

/** The winning filename flag: true for -H, false for -h, null for neither. */
// [-l, -L]: which file-listing mode wins, the later one on the line. GNU's
// -l and -L set one variable (`list_files`) so the last typed wins: `grep -l
// -L` lists the files WITHOUT a match and `grep -L -l` the ones with one
// (measured on grep 3.11).
export function listingMode(fl: FlagView): [boolean, boolean] {
  let winner: string | null = null
  for (const name of fl.typedOrder('files_with_matches', 'files_without_match')) {
    if (fl.asBool(name)) winner = name
  }
  return [winner === 'files_with_matches', winner === 'files_without_match']
}

export function filenameMode(fl: FlagView): boolean | null {
  let mode: boolean | null = null
  for (const name of fl.typedOrder('with_filename', 'no_filename')) {
    if (fl.asBool(name)) mode = name === 'with_filename'
  }
  return mode
}

function reason(error: unknown): string {
  return fsStrerror(error) ?? (error instanceof Error ? error.message : String(error))
}

export function parseFlags(fl: FlagView): FlagSet {
  const mode = binaryMode(fl)
  const filename = filenameMode(fl)
  const [filesOnly, filesWithoutMatch] = listingMode(fl)
  // GNU checks each context option as it is read, so the first bad one on
  // the line is the one named.
  const contexts = new Map<string, number | undefined>()
  for (const name of fl.typedOrder('after_context', 'before_context', 'context'))
    contexts.set(name, contextLength(fl, name))
  const aCtx = contexts.get('after_context')
  const bCtx = contexts.get('before_context')
  const cCtx = contexts.get('context')
  checkActions(fl)
  const directories = directoriesAction(fl)
  return {
    binaryMode: mode,
    recursive: directories === 'recurse',
    // -R follows every link wherever it stands on the line, -r after it
    // included (grep 3.11).
    dereference: fl.asBool('dereference_recursive'),
    skipDirectories: directories === 'skip',
    skipDevices: fl.asStr('devices') === 'skip',
    filters: {
      fileGlobs: parseFileGlobs(fl),
      excludeDir: fl.asList('exclude_dir'),
      text: mode === 'text',
    },
    ignoreCase: ignoresCase(fl),
    invert: fl.asBool('invert_match'),
    lineNumbers: fl.asBool('line_number'),
    byteOffsets: fl.asBool('byte_offset'),
    countOnly: fl.asBool('count'),
    filesOnly,
    filesWithoutMatch,
    wholeWord: fl.asBool('word_regexp'),
    lineRegexp: fl.asBool('line_regexp'),
    fixedString: fl.asBool('fixed_strings'),
    // grep reads a basic expression unless -E or -P says otherwise; -G asks
    // for the default explicitly.
    syntax: matcherSyntax(fl),
    onlyMatching: fl.asBool('only_matching'),
    maxCount: maxCount(fl),
    quiet: fl.asBool('quiet'),
    noMessages: fl.asBool('no_messages'),
    withFilename: filename === true,
    noFilename: filename === false,
    afterContext: aCtx ?? cCtx ?? null,
    beforeContext: bCtx ?? cCtx ?? null,
    nullData: fl.asBool('null_data'),
    null: fl.asBool('null'),
    initialTab: fl.asBool('initial_tab'),
    groupSeparator: groupSeparator(fl),
    label: fl.asStr('label') ?? GREP_STDIN_LABEL,
  }
}

export async function grepGeneric(
  name: string,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: Stat,
  readdir: Readdir,
  stream: Stream,
): Promise<CommandFnResult> {
  stat = stdinStat(stat)
  const operandStream = stdinStream(stream, ctx.stdin)
  stream = (path) => guardInput(operandStream(path), ctx)
  const fl = new FlagView(ctx.flags, specOf('grep'))
  // GNU refuses a bad option value in its option loop, before it looks for a
  // pattern.
  let f: FlagSet
  try {
    f = parseFlags(fl)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    const exitCode = error instanceof UsageError ? error.exitCode : 2
    return [null, new IOResult({ exitCode, stderr: ENC.encode(error.message + '\n') })]
  }
  const resolution = await resolvePattern(name, texts, fl, stream)
  if (resolution.error !== null || resolution.pattern === null)
    return [
      null,
      new IOResult({
        exitCode: 2,
        stderr: ENC.encode(resolution.error ?? `${GREP_NO_PATTERN}\n`),
      }),
    ]
  if (resolution.neverMatch) f.fixedString = false
  const utf8 = utf8Locale(ctx.env)
  // -G, -E and -F run in mirage-rs, which compiles the list once for every
  // input; -P stays with the host's PCRE translation.
  let pat: RegExp | null = null
  let rs: OpenStream | null = null
  let warning: Uint8Array
  try {
    if (f.syntax === RegexSyntax.PERL) {
      pat = resolution.neverMatch
        ? new RegExp(NEVER_MATCH)
        : compilePerl(
            byteView(resolution.pattern, utf8),
            f.ignoreCase,
            f.wholeWord,
            utf8,
            f.lineRegexp,
          )
      warning = ENC.encode(lineWarnings(fl, null))
    } else {
      const [opened, warnings] = await openGrep(
        streamConfig(f, resolution.neverMatch ? null : resolution.pattern, utf8),
      )
      rs = opened
      warning = fl.asBool('unix_byte_offsets')
        ? concat([ENC.encode(UNIX_BYTE_OFFSETS), warnings])
        : warnings
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(error.message + '\n') })]
  }
  const searcher = rs
  let worker: Worker | undefined
  const search = (
    source: AsyncIterable<Uint8Array>,
    label: string,
    show: boolean,
    fileIO: IOResult,
    afterOutput = false,
    size: number | null = null,
  ): AsyncIterable<Uint8Array> =>
    searcher !== null
      ? streamInput(source, searcher, label, show, fileIO, afterOutput, size, ctx.signal)
      : grepInput(
          source,
          pat ?? new RegExp(NEVER_MATCH),
          f,
          label,
          show,
          fileIO,
          afterOutput,
          ctx.signal,
          utf8,
          size,
          worker,
        )
  // The stream is released however the output ends, read or not.
  const owned = (output: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> =>
    searcher === null
      ? output
      : new OutputStream(output[Symbol.asyncIterator](), () => {
          searcher.close()
          return Promise.resolve()
        })
  const io = warning.byteLength > 0 ? new IOResult({ stderr: warning }) : new IOResult()
  io.exitCode = 1
  const first = paths[0]
  if (first === undefined) {
    try {
      const source = guardInput(resolveSource(ctx.stdin), ctx)
      return [
        owned(search(source, f.label ?? GREP_STDIN_LABEL, f.withFilename && !f.noFilename, io)),
        io,
      ]
    } catch (error) {
      searcher?.close()
      if (!(error instanceof Error)) throw error
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(error.message + '\n') })]
    }
  }
  if (searcher === null) worker = new Worker()
  const mounts = mountsOf(ctx)
  const rd = mountParentReaddir((p: string) => readdir(toPathspec(p)), mounts, mountRoot(ctx))
  const st = mountParentStat((p: string) => stat(toPathspec(p)), mounts)
  // The walk meets links as entries: -r leaves them, -R reads what each one
  // leads to, and a directory it reaches again is a loop.
  const follow = f.recursive && f.dereference === true ? (linksOf(ctx) ?? null) : null
  const walkedSt = (p: string) => followedStat(st, follow, p)
  let failed = false
  const notices: Uint8Array[] = []
  let matched = false
  let printed = false

  function warn(message: string): void {
    failed = true
    io.exitCode = exitCodeFor(matched, failed, f.quiet)
    if (!f.noMessages) notices.push(ENC.encode(message + '\n'))
  }

  function updateStatus(fileIO: IOResult): void {
    io.exitCode = exitCodeFor(matched || fileIO.exitCode === 0, failed, f.quiet)
  }

  async function* scan(
    p: PathSpec,
    walked = false,
    chain: readonly string[] = [],
  ): AsyncIterable<Uint8Array> {
    let info: FileStat
    let entries: string[] = []
    try {
      // The probes below go by `virtual`, which cannot carry the walk's
      // verdict on an operand it refused.
      if (p.walkError !== null) throw walkRefusal(p)
      info = isStdin(p) ? await stat(p) : await (walked ? walkedSt : st)(p.virtual)
      if (follow !== null && info.type === FileType.DIRECTORY) {
        const here = follow.resolve(p.virtual)
        if (chain.includes(here)) {
          if (!f.noMessages)
            notices.push(ENC.encode(`${name}: ${p.rawPath}: warning: recursive directory loop\n`))
          return
        }
        chain = [...chain, here]
      }
      if (info.type === FileType.DIRECTORY && f.recursive) entries = await rd(p.virtual)
    } catch (error) {
      if (!isWalkError(error)) throw error
      warn(`${name}: ${p.rawPath}: ${reason(error)}`)
      return
    }
    if (walked && follow !== null && info.type === FileType.SYMLINK) {
      warn(`${name}: ${p.rawPath}: ${posixPhrase('ENOENT')}`)
      return
    }
    if (info.type === FileType.DIRECTORY) {
      if (f.skipDirectories === true) return
      if (!f.recursive) {
        warn(`${name}: ${p.rawPath}: Is a directory`)
        // GNU 3.11 still lists it under -L: nothing was read from it, so
        // nothing in it matched. -q suppresses the row like every other
        // normal output.
        if (f.filesWithoutMatch && !f.quiet) yield ENC.encode(p.rawPath + nameEnd(f))
        return
      }
      for (const entry of entries) {
        const child = new PathSpec({
          virtual: entry,
          directory: entry,
          vfsPath: stripSlash(entry),
          rawPath: respellOne(entry, p.virtual, p.rawPath),
        })
        if (!dirAdmitted(entry, f.filters)) {
          let probe: FileStat
          try {
            probe = await walkedSt(entry)
          } catch (error) {
            if (!isWalkError(error)) throw error
            warn(`${name}: ${child.rawPath}: ${reason(error)}`)
            continue
          }
          if (probe.type === FileType.DIRECTORY) continue
        }
        yield* scan(child, true, chain)
        if (f.quiet && matched) break
      }
      return
    }
    if (walked && info.type !== FileType.FILE) return
    if (f.skipDevices === true && DEVICE_TYPES.has(info.type) && !isStdin(p)) return
    if (walked && !f.filters.text && BINARY_EXTENSIONS.has(getExtension(p.virtual) ?? '')) return
    if (!fileAdmitted(p.virtual, f.filters)) return
    const fileIO = new IOResult({ exitCode: 1 })
    try {
      try {
        const show = !f.noFilename && (f.withFilename || walked || paths.length > 1)
        for await (const chunk of search(
          stream(p),
          operandLabel(p, f.label ?? GREP_STDIN_LABEL),
          show,
          fileIO,
          printed,
          info.type === FileType.FILE ? (info.size ?? null) : null,
        )) {
          updateStatus(fileIO)
          printed = true
          yield chunk
        }
      } finally {
        matched ||= fileIO.exitCode === 0
        updateStatus(fileIO)
        if (fileIO.stderr !== null) notices.push(await materialize(fileIO.stderr))
      }
    } catch (error) {
      if (!isFsError(error)) throw error
      warn(`${name}: ${p.rawPath}: ${reason(error)}`)
    }
  }

  async function* run(): AsyncIterable<Uint8Array> {
    try {
      for (const path of paths) {
        try {
          yield* scan(path)
        } catch (err) {
          if (!(err instanceof ScanLimitError)) throw err
          warn(`grep: ${err.message}`)
        }
        if (f.quiet && matched) break
      }
    } finally {
      await worker?.close()
      if (notices.length > 0) io.stderr = concat([await materialize(io.stderr), ...notices])
    }
  }

  return [owned(run()), io]
}
