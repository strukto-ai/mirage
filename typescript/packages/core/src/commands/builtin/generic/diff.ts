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

import { chunks } from '../../../io/cooperative.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { DiffPool } from '../../../rs/diff_pool.ts'
import type { DiffComputer, PairResult } from '../../../rs/diff_types.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import type { Argument } from '../../spec/types.ts'
import { compileSpec } from '../../spec/compile.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { concat } from '../../../utils/bytes.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, PathSpec } from '../../../types.ts'
import { gnuBasename } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { Context } from '../../config.ts'
import type { StatPath } from '../../../view/types.ts'
import { formatFsError } from '../../../errors/render.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { fsStrerror, isEnoent, isFsError } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { followedStat } from '../../../view/namespace_view.ts'
import { extraOperandError, missingOperandError, usageHint } from '../../spec/usage.ts'
import { isStdin, stdinStat, stdinStream } from '../utils/stream.ts'
import { UsageError } from '../../errors.ts'
import { beforeFullScan } from '../utils/tree.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { fullIsoTime } from '../utils/formatting.ts'
import { UTC_ZONE, zoneFromEnv, type Zone } from '../../../utils/timezone.ts'
import { linksOf, dispatchOf } from '../utils/links.ts'
import { vfsStatPath } from '../utils/paths.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Readdir = (p: PathSpec) => Promise<string[]>
type Stat = (p: PathSpec) => Promise<FileStat>

interface DiffFlags {
  readonly ignoreCase: boolean
  readonly ignoreAllSpace: boolean
  readonly ignoreSpaceChange: boolean
  readonly ed: boolean
  readonly unified: boolean
  readonly context: number
  readonly brief: boolean
  readonly recursive: boolean
  /** -N reads a file missing on either side as empty. */
  readonly newFile: boolean
  /** --unidirectional-new-file (or -N) reads one missing from the first so. */
  readonly newFirst: boolean
  /** -s reports a pair that does not differ. */
  readonly identical: boolean
  readonly exclude: readonly string[]
  readonly excludeFrom: readonly PathSpec[]
}

function parseFlags(bag: Record<string, FlagValue>): DiffFlags {
  const fl = new FlagView(bag, specOf('diff'))
  let context = -1
  let unified = fl.asBool('u')
  for (const [, value] of fl.occurrences('U', 'unified')) {
    unified = true
    if (value === true) context = Math.max(context, 3)
    else if (
      typeof value === 'string' &&
      (value === '' || /^[ \t\n\r\v\f]*[+-]?[0-9]+$/.test(value)) &&
      Number(value) >= 0
    )
      context = Math.max(context, Math.min(Number(value), Number.MAX_SAFE_INTEGER))
    else
      throw new UsageError(`diff: invalid context length '${String(value)}'\n${usageHint('diff')}`)
  }
  const newFile = fl.asBool('new_file')
  return {
    ignoreCase: fl.asBool('i'),
    ignoreAllSpace: fl.asBool('w'),
    ignoreSpaceChange: fl.asBool('b'),
    ed: fl.asBool('e'),
    unified,
    context: context === -1 ? 3 : context,
    brief: fl.asBool('brief'),
    recursive: fl.asBool('recursive'),
    newFile,
    newFirst: newFile || fl.asBool('unidirectional_new_file'),
    identical: fl.asBool('report_identical_files'),
    exclude: fl.asList('exclude'),
    excludeFrom: fl.asPaths('exclude_from'),
  }
}

interface Walk {
  readonly computer: DiffComputer
  readonly signal: AbortSignal | undefined
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  readdir: Readdir
  stat: Stat
  flags: DiffFlags
  excluded: readonly string[]
  switches: string
  statPath: StatPath | null
  zone: Zone
  // An entry diff could not compare, reported as it goes on (exit 2).
  readonly trouble: Uint8Array[]
  // The directory a path resolves to, where diff follows links.
  real: ((virtual: string) => string) | null
}

type Absent = readonly [boolean, boolean]

const PRESENT: Absent = [false, false]

// The characters GNU diff spells as a C escape in a header name. Any other
// control character is three octal digits.
const HEADER_ESCAPES: Readonly<Record<string, string>> = {
  '\x07': 'a',
  '\b': 'b',
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
  '"': '"',
  '\\': '\\',
}

/**
 * A file name as GNU diff writes it in a header line. GNU diff double-quotes
 * a name holding a space, a double quote, a backslash or a control
 * character, and writes each of those but the space as a C escape
 * (`"sp ace"`, `"t\\tab"`); any other name, bytes above ASCII included, is
 * written as it is. The `---` and `+++` lines and the `diff -r` line use it;
 * the `Only in` and `Files ... differ` lines do not. Mirrors Python's
 * `quote_header_name`.
 */
export function quoteHeaderName(name: string): string {
  const special = (ch: string): boolean =>
    ch === ' ' || Object.hasOwn(HEADER_ESCAPES, ch) || ch < ' '
  if (!Array.from(name).some(special)) return name
  let out = ''
  for (const ch of name) {
    const escape = Object.hasOwn(HEADER_ESCAPES, ch) ? HEADER_ESCAPES[ch] : undefined
    if (escape !== undefined) out += '\\' + escape
    else if (ch < ' ') out += '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0')
    else out += ch
  }
  return `"${out}"`
}

// The time a unified header gives one side, as GNU diff prints it: the
// modification time as `%Y-%m-%d %H:%M:%S.%N %z` in the zone `TZ` names, read
// through the dispatcher as `stat` reads it, so a time `touch` keeps in the namespace shows; the
// epoch for a side -N reads as absent; and the present moment for standard
// input, as POSIX asks and diffutils does.
async function headerTime(walk: Walk, path: PathSpec, absent: boolean): Promise<string> {
  if (absent) return fullIsoTime(null, walk.zone)
  if (isStdin(path)) return fullIsoTime(new Date().toISOString(), walk.zone)
  const info =
    (walk.statPath !== null ? await walk.statPath(path) : null) ?? (await walk.stat(path))
  return fullIsoTime(info.modified, walk.zone)
}

function childSpec(parent: PathSpec, name: string): PathSpec {
  const childPath = `${rstripSlash(parent.virtual)}/${name}`
  return new PathSpec({
    virtual: childPath,
    directory: childPath,
    resolved: false,
    vfsPath: mountKey(childPath, mountPrefixOf(parent.virtual, parent.vfsPath)),
    rawPath: `${rstripSlash(parent.rawPath)}/${name}`,
  })
}

function takesValue(option: Argument): boolean {
  return option.action !== 'store_true' && option.action !== 'count' && !(option.nargs === '?')
}

/**
 * The option words of a diff line, as GNU echoes them. GNU diff permutes its
 * options in front of its operands and prints them, word for word and in
 * order, on each `diff -r` header line: an option's detached value is its
 * own word, `--` is kept, and every operand is left out.
 */
export function switchWords(argv: readonly string[]): string[] {
  const options = compileSpec(specOf(CommandName.DIFF)).options
  const shorts = new Map(
    options.flatMap((o) =>
      o.names.filter((name) => !name.startsWith('--')).map((name) => [name.slice(1), o]),
    ),
  )
  const longs = new Map(
    options.flatMap((o) =>
      o.names.filter((name) => name.startsWith('--')).map((name) => [name.slice(2), o]),
    ),
  )
  const words: string[] = []
  let i = 0
  while (i < argv.length) {
    const word = argv[i] ?? ''
    i += 1
    if (word === '--') {
      words.push(word)
      break
    }
    if (!word.startsWith('-') || word === '-') continue
    words.push(word)
    if (word.startsWith('--')) {
      const name = word.slice(2).split('=')[0] ?? ''
      const found = longs.get(name)
      const matches =
        found !== undefined
          ? [found]
          : [...longs].filter(([n]) => n.startsWith(name)).map(([, o]) => o)
      const only = matches.length === 1 ? matches[0] : undefined
      if (!word.includes('=') && only !== undefined && takesValue(only) && i < argv.length) {
        words.push(argv[i] ?? '')
        i += 1
      }
      continue
    }
    for (let at = 1; at < word.length; at++) {
      const option = shorts.get(word[at] ?? '')
      if (option !== undefined && takesValue(option)) {
        if (at === word.length - 1 && i < argv.length) {
          words.push(argv[i] ?? '')
          i += 1
        }
        break
      }
    }
  }
  return words
}

async function diffPair(
  walk: Walk,
  path1: PathSpec,
  path2: PathSpec,
  absent: Absent = PRESENT,
): Promise<PairResult> {
  const flags = walk.flags
  const headers =
    flags.unified && !flags.brief && !flags.ed
      ? {
          old_header: `${quoteHeaderName(path1.rawPath)}\t${await headerTime(walk, path1, absent[0])}`,
          new_header: `${quoteHeaderName(path2.rawPath)}\t${await headerTime(walk, path2, absent[1])}`,
        }
      : {}
  const result = await walk.computer.compare(
    {
      mode: flags.ed ? 'ed' : flags.unified ? 'unified' : 'normal',
      context: flags.context,
      ignore_case: flags.ignoreCase,
      ignore_all_space: flags.ignoreAllSpace,
      ignore_space_change: flags.ignoreSpaceChange,
      text: false,
      brief: flags.brief,
      old_label: path1.rawPath,
      new_label: path2.rawPath,
      old_header: headers.old_header ?? '',
      new_header: headers.new_header ?? '',
    },
    () => (absent[0] ? new Uint8Array() : walk.stream(path1)),
    () => (absent[1] ? new Uint8Array() : walk.stream(path2)),
    walk.signal,
  )
  if (result.outcome === 'equal' && flags.identical && result.status === 0)
    return {
      ...result,
      output: [ENC.encode(`Files ${path1.rawPath} and ${path2.rawPath} are identical\n`)],
    }
  if (result.outcome === 'different' && flags.brief)
    return {
      ...result,
      output: [ENC.encode(`Files ${path1.rawPath} and ${path2.rawPath} differ\n`)],
    }
  return result
}

async function entries(walk: Walk, path: PathSpec, absent: boolean): Promise<Set<string>> {
  if (absent) return new Set()
  const names = (await walk.readdir(path)).map((e) => gnuBasename(e))
  return new Set(names.filter((name) => !walk.excluded.some((pattern) => fnmatch(name, pattern))))
}

// What an entry is, as diff's stat follows it; null, and the entry named in
// `trouble`, for one it cannot stat or a link that leads nowhere. GNU names
// each such entry on each side and goes on with the rest, the pair left
// uncompared (exit 2). Mirrors Python's _entry_kind.
async function entryKind(walk: Walk, path: PathSpec): Promise<FileType | null> {
  let row: FileStat
  try {
    row = await walk.stat(path)
  } catch (err) {
    if (!isFsError(err)) throw err
    walk.trouble.push(ENC.encode(`diff: ${path.rawPath}: ${String(fsStrerror(err))}\n`))
    return null
  }
  if (row.type === FileType.SYMLINK) {
    walk.trouble.push(ENC.encode(`diff: ${path.rawPath}: ${posixPhrase('ENOENT')}\n`))
    return null
  }
  return row.type
}

/**
 * Compare two directories, one of which -N may read as empty; returns the
 * report and whether any pair differed. Where diff follows links, a pair whose
 * every side is a directory already open above it on that side (`above`, as
 * the paths they resolve to) is GNU's recursive directory loop: named and left
 * unread (exit 2).
 */
async function diffDirs(
  walk: Walk,
  dirA: PathSpec,
  dirB: PathSpec,
  absent: Absent = PRESENT,
  above: readonly [readonly string[], readonly string[]] = [[], []],
): Promise<[readonly Uint8Array[], boolean]> {
  const flags = walk.flags
  const real = walk.real
  const opened: readonly [readonly string[], readonly string[]] =
    real === null
      ? above
      : [
          absent[0] ? above[0] : [...above[0], real(dirA.virtual)],
          absent[1] ? above[1] : [...above[1], real(dirB.virtual)],
        ]
  const namesA = await entries(walk, dirA, absent[0])
  const namesB = await entries(walk, dirB, absent[1])
  const names = [...new Set([...namesA, ...namesB])].sort(compareCodePoints)
  const left = rstripSlash(dirA.rawPath)
  const right = rstripSlash(dirB.rawPath)
  const parts: Uint8Array[] = []
  let differ = false
  for (const name of names) {
    const inA = namesA.has(name)
    const inB = namesB.has(name)
    if (!inB && !flags.newFile) {
      parts.push(ENC.encode(`Only in ${left}: ${name}\n`))
      differ = true
      continue
    }
    if (!inA && !flags.newFirst) {
      parts.push(ENC.encode(`Only in ${right}: ${name}\n`))
      differ = true
      continue
    }
    const childA = childSpec(dirA, name)
    const childB = childSpec(dirB, name)
    const kindA = inA ? await entryKind(walk, childA) : null
    const kindB = inB ? await entryKind(walk, childB) : null
    if ((inA && kindA === null) || (inB && kindB === null)) continue
    const aDir = kindA === FileType.DIRECTORY
    const bDir = kindB === FileType.DIRECTORY
    const gone: Absent = [!inA, !inB]
    if ((aDir || !inA) && (bDir || !inB)) {
      if (
        real !== null &&
        [childA, childB].every(
          (child, i) => gone[i] === true || opened[i]?.includes(real(child.virtual)) === true,
        )
      ) {
        const named = inA ? childA : childB
        walk.trouble.push(ENC.encode(`diff: ${named.rawPath}: recursive directory loop\n`))
        continue
      }
      const [body, changed] = await diffDirs(walk, childA, childB, gone, opened)
      parts.push(...body)
      differ ||= changed
    } else if (!aDir && !bDir) {
      const pair = await diffPair(walk, childA, childB, gone)
      if (pair.stderr.length > 0) walk.trouble.push(...pair.stderr)
      if (pair.status === 2 && pair.stderr.length === 0)
        walk.trouble.push(ENC.encode('diff: comparison failed\n'))
      if (pair.outcome === 'equal') {
        parts.push(...pair.output)
        continue
      }
      differ = true
      if (flags.brief) parts.push(...pair.output)
      else
        parts.push(
          ENC.encode(
            `diff${walk.switches} ${quoteHeaderName(childA.rawPath)} ${quoteHeaderName(childB.rawPath)}\n`,
          ),
          ...pair.output,
        )
    } else if (aDir) {
      differ = true
      parts.push(
        ENC.encode(
          `File ${childA.rawPath} is a directory while file ${childB.rawPath} is a regular file\n`,
        ),
      )
    } else {
      differ = true
      parts.push(
        ENC.encode(
          `File ${childA.rawPath} is a regular file while file ${childB.rawPath} is a directory\n`,
        ),
      )
    }
  }
  return [parts, differ]
}

async function missing(stat: Stat, path: PathSpec, allowed: boolean): Promise<boolean> {
  if (!allowed || isStdin(path)) return false
  try {
    await stat(path)
  } catch (err) {
    if (isEnoent(err)) return true
    throw err
  }
  return false
}

async function excludedPatterns(
  flags: DiffFlags,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<string[]> {
  const patterns = [...flags.exclude]
  for (const path of flags.excludeFrom) {
    const text = DEC.decode(await materialize(stream(path)))
    patterns.push(...text.split('\n').filter((line) => line !== ''))
  }
  return patterns
}

export async function diffGeneric(
  paths: PathSpec[],
  ctx: Context,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readdir: Readdir,
  backendStat: Stat,
): Promise<[ByteSource | null, IOResult]> {
  const flags = parseFlags(ctx.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.DIFF, paths[2]?.rawPath ?? '')
  if (paths.length < 2)
    throw missingOperandError(CommandName.DIFF, paths[0]?.rawPath ?? null, ctx.argv ?? [])
  const p0 = paths[0]
  const p1 = paths[1]
  if (p0 === undefined || p1 === undefined) return [null, new IOResult()]
  // Both name the one stdin, which GNU sees as the same file.
  if (isStdin(p0) && isStdin(p1)) return [null, new IOResult()]
  const stream = stdinStream(read, ctx.stdin)
  const stat = stdinStat(backendStat)
  const dash0 = p0.rawPath === '-'
  const dash1 = p1.rawPath === '-'
  const errorPaths = [...paths, ...flags.excludeFrom]
  const links = linksOf(ctx)
  const trouble: Uint8Array[] = []
  let output: readonly Uint8Array[] | undefined
  let differ = false
  const owned = ctx.diff === undefined ? new DiffPool() : undefined
  const computer = ctx.diff ?? owned
  if (computer === undefined) throw new Error('diff computer is missing')
  try {
    const walk: Walk = {
      computer,
      signal: ctx.signal,
      stream,
      readdir,
      // diff compares what each link leads to (its default --dereference),
      // the operands' own taken there at dispatch.
      stat: (p: PathSpec) => followedStat(stat, links, p),
      flags,
      excluded: await excludedPatterns(flags, stream),
      switches: switchWords(ctx.argv ?? [])
        .map((word) => ` ${shellQuote(word)}`)
        .join(''),
      statPath: vfsStatPath(ctx.vfs) ?? null,
      zone: zoneFromEnv(ctx.env) ?? UTC_ZONE,
      trouble,
      real: links === undefined ? null : (virtual: string) => links.resolve(virtual),
    }
    if (dash0 !== dash1) {
      if ((await stat(dash0 ? p1 : p0)).type === FileType.DIRECTORY) {
        return [
          null,
          new IOResult({
            exitCode: 2,
            stderr: ENC.encode("diff: cannot compare '-' to a directory\n"),
          }),
        ]
      }
    }
    // A missing operand -N reads as empty only beside one that is there:
    // two missing ones are both reported.
    const absent: Absent = [
      await missing(stat, p0, flags.newFirst),
      await missing(stat, p1, flags.newFile),
    ]
    if (absent[0] && absent[1]) {
      const lines: Uint8Array[] = []
      for (const path of paths) {
        try {
          await stat(path)
        } catch (err) {
          if (!isFsError(err)) throw err
          lines.push(formatFsError('diff', err, [path]))
        }
      }
      return [null, new IOResult({ exitCode: 2, stderr: concat(lines) })]
    }
    if (flags.recursive && !absent[0] && !absent[1]) {
      const bothDirs =
        (await stat(p0)).type === FileType.DIRECTORY && (await stat(p1)).type === FileType.DIRECTORY
      if (bothDirs) {
        for (const path of [p0, p1]) await beforeFullScan(dispatchOf(ctx), path, 'diff')
        ;[output, differ] = await diffDirs(walk, p0, p1)
      }
    }
    if (output === undefined) {
      const pair = await diffPair(walk, p0, p1, absent)
      output = pair.output
      differ = pair.outcome === 'different'
      if (pair.stderr.length > 0) trouble.push(...pair.stderr)
      if (pair.status === 2 && pair.stderr.length === 0)
        trouble.push(ENC.encode('diff: comparison failed\n'))
    }
  } catch (err) {
    if (err instanceof StreamRefusal)
      return [
        err.output,
        new IOResult({ exitCode: 2, stderr: ENC.encode(`diff: ${err.message}\n`) }),
      ]
    if (!isFsError(err)) {
      if (
        err instanceof UsageError ||
        err instanceof CommandTimeoutError ||
        err instanceof PipeClosed ||
        (err instanceof Error && err.name === 'AbortError')
      )
        throw err
      return [
        null,
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode(`diff: ${err instanceof Error ? err.message : String(err)}\n`),
        }),
      ]
    }
    // GNU diff reserves exit 1 for "files differ"; trouble (a missing or
    // unreadable operand) is exit 2.
    return [null, new IOResult({ exitCode: 2, stderr: formatFsError('diff', err, errorPaths) })]
  } finally {
    await owned?.close()
  }
  const out: ByteSource = outputChunks(output)
  if (trouble.length > 0) return [out, new IOResult({ exitCode: 2, stderr: concat(trouble) })]
  return [out, new IOResult({ exitCode: differ ? 1 : 0 })]
}

async function* outputChunks(parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield* chunks(part)
}
