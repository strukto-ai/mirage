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

import { utf8Locale } from '../../../shell/bytes.ts'
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
import { FileType, LineFacts, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { matcherSyntax, patternWarnings, resolvePattern } from '../grep_pattern.ts'
import { exitCodeFor } from '../grep_scan.ts'
import { BINARY_EXTENSIONS, getExtension } from '../../../utils/filetype.ts'
import { nameEnd, type FlagSet } from '../grep_binary.ts'
import { openGrep, streamConfig, streamInput } from '../grep_stream.ts'
import { OutputStream } from '../../../io/stream.ts'
import type { OpenStream } from '../../../rs/stream.ts'
import type { LineRegex } from '../../../rs/regex.ts'
import { fileAdmitted, dirAdmitted, parseFileGlobs } from '../grep_select.ts'
import { resolveSource } from '../utils/stream.ts'
import { UsageError } from '../../errors.ts'
import { WalkLimitError } from '../../../errors/types.ts'
import { SYNOPSES } from '../../spec/synopsis.ts'
import { usageHint } from '../../spec/usage.ts'
import { scanned } from '../../../rs/scan.ts'
import { GREP_STDIN_LABEL } from '../utils/constants.ts'
import { linksOf, mountsOf, mountRoot } from '../utils/links.ts'

const ENC = new TextEncoder()
// GNU grep with no pattern prints its synopsis and the help hint, exit 2
// (grep 3.11; the same two lines follow `option requires an argument`).
const GREP_NO_PATTERN = `Usage: ${SYNOPSES.grep ?? ''}\n${usageHint('grep')}`
// The types -D skip passes over; stdin is read whatever it is.
const DEVICE_TYPES: ReadonlySet<FileType> = new Set([
  FileType.CHAR_DEVICE,
  FileType.BLOCK_DEVICE,
  FileType.FIFO,
  FileType.SOCKET,
])
const UNIX_BYTE_OFFSETS = 'grep: warning: --unix-byte-offsets (-u) is obsolete\n'
// The options whose values mirage-rs reads, with the switches that decide
// among them.
const SCANNED = [
  'text',
  'args_I',
  'binary_files',
  'after_context',
  'before_context',
  'context',
  'recursive',
  'dereference_recursive',
  'directories',
  'devices',
]
type Stat = (p: PathSpec) => Promise<FileStat>
type Readdir = (p: PathSpec) => Promise<string[]>
type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

/**
 * What grep's scan reads: the binary-files mode, the context lengths (-C
 * filling a side -A or -B left unset), the directory action, whether -D skips
 * devices, and the max count (null for no limit, filled only by `maxCount`).
 * Mirrors Python's `GrepValues`.
 */
export interface GrepValues {
  readonly binary_mode: string
  readonly after_context: number | null
  readonly before_context: number | null
  readonly directories: string
  readonly skip_devices: boolean
  readonly max_count: number | null
}

/**
 * grep's option values but -m, read by mirage-rs in a fixed order; throws
 * UsageError for the first value grep refuses, in its words. Mirrors
 * Python's `scan_values`.
 */
export function scanValues(fl: FlagView): GrepValues {
  return scanned('grep', fl.texts(...SCANNED)) as unknown as GrepValues
}

/**
 * -m as mirage-rs reads it, null for no limit; grep checks it after the
 * matchers, so a bad count yields to conflicting ones. Throws UsageError
 * with grep's refusal. Mirrors Python's `max_count`.
 */
export function maxCount(fl: FlagView): number | null {
  return (scanned('grep', fl.texts('max_count')) as unknown as GrepValues).max_count
}

/**
 * Whether grep walks the directories it meets: -r, -R or a -d naming
 * recurse, the last of the three on the line winning (grep 3.11). A -d word
 * is read by the scan the handler reads (`scanValues`), so the gate and the
 * run share it; a line that scan refuses walks nothing, since grep refuses
 * it before reading a file. Mirrors Python's `recurses`.
 */
export function recurses(fl: FlagView): boolean {
  const last = fl.texts('recursive', 'dereference_recursive', 'directories').at(-1)
  if (last === undefined) return false
  if (last[0] !== 'directories') return true
  try {
    return scanValues(fl).directories === 'recurse'
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.debug(`grep walks nothing past a refused option: ${err.message}`)
    return false
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
export function lineWarnings(fl: FlagView, matcher: LineRegex | null): string {
  return (
    (fl.asBool('unix_byte_offsets') ? UNIX_BYTE_OFFSETS : '') +
    (matcher === null ? '' : patternWarnings(matcher))
  )
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
  const values = scanValues(fl)
  const mode = values.binary_mode
  const filename = filenameMode(fl)
  const [filesOnly, filesWithoutMatch] = listingMode(fl)
  const directories = values.directories
  return {
    binaryMode: mode,
    recursive: directories === 'recurse',
    // -R follows every link wherever it stands on the line, -r after it
    // included (grep 3.11).
    dereference: fl.asBool('dereference_recursive'),
    skipDirectories: directories === 'skip',
    skipDevices: values.skip_devices,
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
    afterContext: values.after_context,
    beforeContext: values.before_context,
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
  // mirage-rs compiles the list once for every input.
  let searcher: OpenStream
  let warning: Uint8Array
  try {
    const [opened, warnings] = await openGrep(
      streamConfig(f, resolution.neverMatch ? null : resolution.pattern, utf8),
    )
    searcher = opened
    warning = fl.asBool('unix_byte_offsets')
      ? concat([ENC.encode(UNIX_BYTE_OFFSETS), warnings])
      : warnings
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(error.message + '\n') })]
  }
  const search = (
    source: AsyncIterable<Uint8Array>,
    label: string,
    show: boolean,
    fileIO: IOResult,
    afterOutput = false,
    size: number | null = null,
  ): AsyncIterable<Uint8Array> =>
    streamInput(source, searcher, label, show, fileIO, afterOutput, size, ctx.signal)
  // The stream is released however the output ends, read or not.
  const owned = (output: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> =>
    new OutputStream(output[Symbol.asyncIterator](), () => {
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
      searcher.close()
      if (!(error instanceof Error)) throw error
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(error.message + '\n') })]
    }
  }
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
        // A -P search that gave up ends its file with an error.
        failed ||= fileIO.exitCode === 2
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
          if (!(err instanceof WalkLimitError)) throw err
          warn(`grep: ${err.message}`)
        }
        if (f.quiet && matched) break
      }
    } finally {
      if (notices.length > 0) io.stderr = concat([await materialize(io.stderr), ...notices])
    }
  }

  return [owned(run()), io]
}

/**
 * A grep line walks, and reads, below the directories it names when it
 * recurses (`recurses`). Mirrors Python's `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  const walks = recurses(fl)
  return new LineFacts({ walks, readsSubtree: walks })
}
