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
import type { Argument } from '../../spec/types.ts'
import { compileSpec } from '../../spec/compile.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { concat } from '../../../io/cachable_iterator.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, PathSpec } from '../../../types.ts'
import { gnuBasename } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandOpts } from '../../config.ts'
import type { StatPath } from '../../../view/types.ts'
import { formatFsError } from '../../../errors/render.ts'
import { isEnoent, isFsError } from '../../../errors/fs.ts'
import { edScript, normalDiff, unifiedDiff } from '../diff_format.ts'
import { extraOperandError, missingOperandError } from '../../spec/usage.ts'
import { isStdin, stdinStat, stdinStream } from '../utils/stream.ts'
import { splitLinesKeepends } from '../utils/lines.ts'
import { UsageError } from '../../errors.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { fullIsoTime } from '../utils/formatting.ts'
import { UTC_ZONE, zoneFromEnv, type Zone } from '../../../utils/timezone.ts'

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
      throw new UsageError(
        `diff: invalid context length '${String(value)}'\ndiff: Try 'diff --help' for more information.`,
      )
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
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>
  readdir: Readdir
  stat: Stat
  flags: DiffFlags
  excluded: readonly string[]
  switches: string
  statPath: StatPath | null
  zone: Zone
}

type Absent = readonly [boolean, boolean]

const PRESENT: Absent = [false, false]

// diffutils' c_escape_char: the characters a header name spells as a C
// escape. Any other control character is three octal digits.
const C_ESCAPES: Readonly<Record<string, string>> = {
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
 * A file name as GNU diff writes it in a header line. diffutils' `c_escape`
 * double-quotes a name holding a space, a double quote, a backslash or a
 * control character, and writes each of those but the space as a C escape
 * (`"sp ace"`, `"t\\tab"`); any other name, bytes above ASCII included, is
 * written as it is. The `---` and `+++` lines and the `diff -r` line use it;
 * the `Only in` and `Files ... differ` lines do not. Mirrors Python's
 * `c_escape`.
 */
export function cEscape(name: string): string {
  const special = (ch: string): boolean => ch === ' ' || Object.hasOwn(C_ESCAPES, ch) || ch < ' '
  if (!Array.from(name).some(special)) return name
  let out = ''
  for (const ch of name) {
    const escape = Object.hasOwn(C_ESCAPES, ch) ? C_ESCAPES[ch] : undefined
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

async function side(walk: Walk, path: PathSpec, absent: boolean): Promise<string> {
  return absent ? '' : DEC.decode(await materialize(walk.stream(path)))
}

async function diffPair(
  walk: Walk,
  path1: PathSpec,
  path2: PathSpec,
  absent: Absent = PRESENT,
): Promise<Uint8Array> {
  const flags = walk.flags
  let textA = await side(walk, path1, absent[0])
  let textB = await side(walk, path2, absent[1])
  if (flags.ignoreCase) {
    textA = textA.toLowerCase()
    textB = textB.toLowerCase()
  }
  if (flags.ignoreAllSpace) {
    textA = textA.replace(/\s+/g, '')
    textB = textB.replace(/\s+/g, '')
  }
  if (flags.ignoreSpaceChange) {
    textA = textA.replace(/[ \t]+/g, ' ')
    textB = textB.replace(/[ \t]+/g, ' ')
  }
  if (textA === textB) {
    return flags.identical
      ? ENC.encode(`Files ${path1.rawPath} and ${path2.rawPath} are identical\n`)
      : new Uint8Array(0)
  }
  if (flags.brief) return ENC.encode(`Files ${path1.rawPath} and ${path2.rawPath} differ\n`)
  const aLines = splitLinesKeepends(textA)
  const bLines = splitLinesKeepends(textB)
  let result: string[]
  if (flags.ed) result = edScript(aLines, bLines)
  else if (flags.unified)
    result = unifiedDiff(
      aLines,
      bLines,
      cEscape(path1.rawPath),
      cEscape(path2.rawPath),
      flags.context,
      await headerTime(walk, path1, absent[0]),
      await headerTime(walk, path2, absent[1]),
    )
  else result = normalDiff(aLines, bLines)
  return ENC.encode(result.join(''))
}

function isIdentical(body: Uint8Array): boolean {
  return DEC.decode(body).endsWith(' are identical\n')
}

async function entries(walk: Walk, path: PathSpec, absent: boolean): Promise<Set<string>> {
  if (absent) return new Set()
  const names = (await walk.readdir(path)).map((e) => gnuBasename(e))
  return new Set(names.filter((name) => !walk.excluded.some((pattern) => fnmatch(name, pattern))))
}

/**
 * Compare two directories, one of which -N may read as empty; returns the
 * report and whether any pair differed.
 */
async function diffDirs(
  walk: Walk,
  dirA: PathSpec,
  dirB: PathSpec,
  absent: Absent = PRESENT,
): Promise<[Uint8Array, boolean]> {
  const flags = walk.flags
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
    const aDir = inA && (await walk.stat(childA)).type === FileType.DIRECTORY
    const bDir = inB && (await walk.stat(childB)).type === FileType.DIRECTORY
    const gone: Absent = [!inA, !inB]
    if ((aDir || !inA) && (bDir || !inB)) {
      const [body, changed] = await diffDirs(walk, childA, childB, gone)
      parts.push(body)
      differ ||= changed
    } else if (!aDir && !bDir) {
      const body = await diffPair(walk, childA, childB, gone)
      if (body.byteLength === 0 || isIdentical(body)) {
        parts.push(body)
        continue
      }
      differ = true
      if (flags.brief) parts.push(body)
      else
        parts.push(
          concat([
            ENC.encode(
              `diff${walk.switches} ${cEscape(childA.rawPath)} ${cEscape(childB.rawPath)}\n`,
            ),
            body,
          ]),
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
  return [concat(parts), differ]
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
  opts: CommandOpts,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
  readdir: Readdir,
  backendStat: Stat,
): Promise<[ByteSource | null, IOResult]> {
  const flags = parseFlags(opts.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.DIFF, paths[2]?.rawPath ?? '')
  if (paths.length < 2)
    throw missingOperandError(CommandName.DIFF, paths[0]?.rawPath ?? null, opts.argv ?? [])
  const p0 = paths[0]
  const p1 = paths[1]
  if (p0 === undefined || p1 === undefined) return [null, new IOResult()]
  // Both name the one stdin, which GNU sees as the same file.
  if (isStdin(p0) && isStdin(p1)) return [null, new IOResult()]
  const stream = stdinStream(read, opts.stdin)
  const stat = stdinStat(backendStat)
  const dash0 = p0.rawPath === '-'
  const dash1 = p1.rawPath === '-'
  const errorPaths = [...paths, ...flags.excludeFrom]
  let output: Uint8Array | undefined
  let differ = false
  try {
    const walk: Walk = {
      stream,
      readdir,
      stat,
      flags,
      excluded: await excludedPatterns(flags, stream),
      switches: switchWords(opts.argv ?? [])
        .map((word) => ` ${shellQuote(word)}`)
        .join(''),
      statPath: opts.statPath ?? null,
      zone: zoneFromEnv(opts.env) ?? UTC_ZONE,
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
      if (bothDirs) [output, differ] = await diffDirs(walk, p0, p1)
    }
    if (output === undefined) {
      output = await diffPair(walk, p0, p1, absent)
      differ = output.byteLength > 0 && !isIdentical(output)
    }
  } catch (err) {
    if (!isFsError(err)) throw err
    // GNU diff reserves exit 1 for "files differ"; trouble (a missing or
    // unreadable operand) is exit 2.
    return [null, new IOResult({ exitCode: 2, stderr: formatFsError('diff', err, errorPaths) })]
  }
  const out: ByteSource = output
  return [out, new IOResult({ exitCode: differ ? 1 : 0 })]
}
