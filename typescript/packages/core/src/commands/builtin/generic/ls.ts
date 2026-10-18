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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf, underPath } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import {
  LINK_TARGET_KEY,
  FileStat,
  FileType,
  PathSpec,
  type LsIndicator,
  type LsLinkMode,
  type LsSortBy,
  type LsTimeKind,
} from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { ChildMounts, LinkView, MountView, StatPath } from '../../../view/types.ts'
import {
  LS_TIME_STYLES,
  STAT_FAILED_KEY,
  type LsColumns,
  formatLsLong,
  lsName,
  lsPrefix,
  parseBlockSize,
  timeOf,
  type BlockSizeRefusal,
} from '../utils/formatting.ts'
import { UsageError } from '../../errors.ts'
import { isEntryError } from '../../../errors/classify.ts'
import { wordRefusalError, wordRefusalLine, usageHint } from '../../spec/usage.ts'
import { type WordRefusalKind, matchWord } from '../../spec/word_choice.ts'
import { identityOf, type Identity } from '../utils/identity.ts'
import {
  fsStrerror,
  isDotWalkError,
  isEacces,
  isMissError,
  isMissingPath,
  isWalkError,
} from '../../../errors/fs.ts'
import { failureText } from '../../../errors/classify.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { followedStat } from '../../../view/namespace_view.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { respellOne, posixNormpath } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { contentSize } from '../../../utils/stat_view.ts'
import { escapeName } from '../../../utils/quote.ts'
import { charWidth } from '../../../utils/width.ts'
import { linksOf, mountsOf, owedNames } from '../utils/links.ts'
import { vfsStatPath } from '../utils/paths.ts'

type Readdir = (p: PathSpec) => Promise<string[]>
type Stat = (p: PathSpec) => Promise<FileStat>

export const LS_OK = 0
export const LS_MINOR_PROBLEM = 1
export const LS_FAILURE = 2

// One diagnostic plus how serious GNU ls considers it: `serious` marks a
// failure on a command-line operand (exit 2); everything met while listing
// or recursing below an operand is a minor problem (exit 1).
interface LsWarning {
  message: string
  serious: boolean
}

interface WalkOpts {
  escape: boolean
  all: boolean
  sortBy: LsSortBy
  reverse: boolean
  // Which timestamp -t compares, and --group-directories-first.
  timeKind: LsTimeKind
  groupDirsFirst: boolean
  recursive: boolean
  // The namespace's symlink facts. The table's readdir names the links
  // among the entries and its stat answers each with its own row.
  links: LinkView | null
  // -L reports the target's stat under the link's own name. A
  // dereferenced directory link then carries FileType.DIRECTORY, which
  // is what makes -R descend it.
  deref: boolean
  // The command line's links were resolved on request (-L, -H), so one that
  // loops is an error rather than a link to list.
  followArgs: boolean
  // Session-filtered child-mount names, merged as directory rows in every
  // listing.
  // GNU lists a mountpoint as an ordinary entry of its parent, -R or
  // not, so the merge is unconditional: withholding it under -R dropped
  // the row whenever the parent's backend held no key of that name.
  childMounts: ChildMounts | null
  // The mount boundaries this walk's readdir cannot cross. Under -R such
  // a root is listed but never descended, because that listing is another
  // backend's and the cross-mount fan-out assembles the group; a
  // namespace-only directory above one is descended, since no other run
  // renders it. Null for a walk that can cross -- the relay's readdir
  // routes per path, so it descends a nested mount itself.
  mounts: MountView | null
  // Dispatcher-backed stat, the only way to learn a child mount's real
  // type. See `mountRow`.
  statPath: StatPath | null
  // Whether the listing prints anything an entry's stat supplies, so an
  // entry whose stat failed is reported. See `statNeeded`.
  statNeeded: boolean
}

// One ls operand once its kind is known. `row` is set when the operand is not
// a directory: GNU prints those first, as one block with no header. `groups`
// holds one [dir, entries] pair per directory listed under the operand — one
// for a plain listing, the whole pre-order subtree under -R. Both empty means
// the operand could not be accessed.
interface Operand {
  readonly path: PathSpec
  readonly row: FileStat | null
  readonly groups: [PathSpec, FileStat[]][]
}

function errText(err: unknown): string {
  return fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))
}

// GNU ratchets the status upward: a serious problem always wins, a minor one
// only upgrades a clean run.
export function exitStatusFor(warnings: readonly LsWarning[]): number {
  if (warnings.some((w) => w.serious)) return LS_FAILURE
  return warnings.length > 0 ? LS_MINOR_PROBLEM : LS_OK
}

function childSpec(entryPath: string, prefix: string): PathSpec {
  return new PathSpec({
    virtual: entryPath,
    directory: entryPath,
    resolved: false,
    vfsPath: mountKey(entryPath, prefix),
  })
}

/**
 * The mark GNU appends to a name for a style (ls.c's get_type_indicator,
 * coreutils 9.7). A directory is `/` in every style but none; `slash` marks
 * nothing else. A link is `@` and a FIFO `|`; an executable regular file is
 * `*`, but only under classify. The mark rides the row's own type and mode, so
 * it needs no separate lookup; a row nothing could stat (a dangling link's
 * target) takes none. Mirrors Python's type_indicator.
 */
export function typeIndicator(entry: FileStat | null, style: LsIndicator): string {
  if (entry === null || style === 'none') return ''
  if (entry.type === FileType.DIRECTORY) return '/'
  if (style === 'slash') return ''
  if (entry.type === FileType.SYMLINK) return '@'
  if (entry.type === FileType.FIFO) return '|'
  if (
    style === 'classify' &&
    entry.type === FileType.FILE &&
    entry.mode !== null &&
    (entry.mode & 0o111) !== 0
  )
    return '*'
  return ''
}

// Short rows: the name, the indicator style's mark, and -i/-Z's lead.
function formatSimple(
  s: FileStat,
  indicator: LsIndicator,
  columns: LsColumns,
  name?: string,
): string {
  return `${lsPrefix(columns)}${name ?? s.name}${typeIndicator(s, indicator)}`
}

/**
 * The long format's name column with the indicator style's marks. GNU marks
 * a row after its name, but a link after its target, with the target's own
 * mark, and only under file-type and classify: `dl -> sub/`, `dang ->
 * nowhere` (coreutils 9.7). Null when no mark is asked for, so the row's own
 * column stands. Mirrors Python's long_names.
 */
function longNames(
  stats: readonly FileStat[],
  names: readonly string[] | null,
  indicator: LsIndicator,
  targets: readonly (FileStat | null)[],
): string[] | null {
  if (indicator === 'none') return names === null ? null : [...names]
  return stats.map((s, i) => {
    const name = names?.[i] ?? lsName(s)
    if (s.type !== FileType.SYMLINK) return name + typeIndicator(s, indicator)
    if (indicator === 'slash') return name
    return name + typeIndicator(targets[i] ?? null, indicator)
  })
}

// What each link row leads to, when the long format marks it. Mirrors
// Python's link_targets.
async function linkTargets(
  stats: readonly FileStat[],
  virtuals: readonly string[],
  links: LinkView | null,
  render: RenderOpts,
): Promise<(FileStat | null)[]> {
  const wanted =
    render.long &&
    links !== null &&
    (render.indicator === 'file-type' || render.indicator === 'classify')
  const out: (FileStat | null)[] = []
  for (const [i, s] of stats.entries()) {
    const virtual = virtuals[i]
    out.push(
      wanted && virtual !== undefined && s.type === FileType.SYMLINK
        ? await links.targetStat(virtual)
        : null,
    )
  }
  return out
}

// A name wrapped in the OSC 8 hyperlink GNU emits under --hyperlink,
// pointing at the entry's virtual path.
function hyperlinked(name: string, virtual: string): string {
  return `\x1b]8;;file://${uriEscape(virtual)}\x07${name}\x1b]8;;\x07`
}

const URI_SAFE = /[A-Za-z0-9~_\-./]/

// Percent-encode a path for a file: URI the way GNU ls does: every byte
// outside the unreserved set and `/` is %xx in lowercase hex, so a
// space, `?` or `#` cannot end the path.
export function uriEscape(path: string): string {
  let out = ''
  for (const ch of path) {
    if (URI_SAFE.test(ch)) {
      out += ch
      continue
    }
    for (const byte of ENC.encode(ch)) out += `%${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

interface RenderOpts {
  escape: boolean
  long: boolean
  human: boolean
  indicator: LsIndicator
  identity: Identity
  columns: LsColumns
}

function appendListing(
  stats: readonly FileStat[],
  render: RenderOpts,
  lines: string[],
  hrefs: readonly string[] | null = null,
  targets: readonly (FileStat | null)[] = [],
): void {
  const names =
    hrefs === null && !render.escape
      ? null
      : stats.map((s, i) => {
          let name = render.escape ? escapeName(s.name) : s.name
          if (hrefs !== null) name = hyperlinked(name, hrefs[i] ?? '')
          const target = s.extra[LINK_TARGET_KEY]
          if (render.long && s.type === FileType.SYMLINK && typeof target === 'string')
            name += ' -> ' + (render.escape ? escapeName(target) : target)
          return name
        })
  if (render.long) {
    const marked = longNames(stats, names, render.indicator, targets)
    const ctx = {
      human: render.human,
      identity: render.identity,
      columns: render.columns,
      ...(marked !== null ? { names: marked } : {}),
    }
    for (const line of formatLsLong(stats, ctx)) lines.push(line)
    return
  }
  stats.forEach((s, i) => lines.push(formatSimple(s, render.indicator, render.columns, names?.[i])))
}

const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39
const isAlpha = (c: number | undefined): boolean =>
  c !== undefined && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))

// gnulib filevercmp's byte order: a tilde sorts before the end of the
// string, ASCII letters by code, and every other byte after the letters.
// gnulib classifies in the C locale one byte at a time, so a multibyte
// letter such as é is two bytes past the letters, not a letter.
function versionOrder(c: number): number {
  if (isDigit(c)) return 0
  if (isAlpha(c)) return c
  if (c === 0x7e) return -1
  return c + 256
}

// Debian's version comparison as gnulib's verrevcmp runs it: alternating
// non-digit and digit runs, the digit runs compared as numbers.
function verrevcmp(a: Uint8Array, b: Uint8Array): number {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = i < a.length ? versionOrder(a[i] ?? 0) : 0
      const bc = j < b.length ? versionOrder(b[j] ?? 0) : 0
      if (ac !== bc) return ac - bc
      i += 1
      j += 1
    }
    while (a[i] === 0x30) i += 1
    while (b[j] === 0x30) j += 1
    let firstDiff = 0
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDiff === 0) firstDiff = (a[i] ?? 0) - (b[j] ?? 0)
      i += 1
      j += 1
    }
    if (isDigit(a[i])) return 1
    if (isDigit(b[j])) return -1
    if (firstDiff !== 0) return firstDiff
  }
  return 0
}

// How much of a name filevercmp compares first: everything but a
// trailing run of suffixes (.txt, .tar.gz, ~).
function versionPrefixLen(s: Uint8Array): number {
  const n = s.length
  let i = 0
  let prefix = 0
  for (;;) {
    if (i === n) return prefix
    i += 1
    prefix = i
    while (i + 1 < n && s[i] === 0x2e && (isAlpha(s[i + 1]) || s[i + 1] === 0x7e)) {
      i += 2
      while (i < n && (isAlpha(s[i]) || isDigit(s[i]) || s[i] === 0x7e)) i += 1
    }
  }
}

// Bytewise order, the tie-break GNU's memcmp gives.
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return a.length - b.length
}

const ENC = new TextEncoder()

// gnulib's filevercmp, the order behind `ls -v`: the empty name, `.` and
// `..` first, then hidden names, then the names compared as versions with
// their suffixes set aside, the suffixes breaking a tie. The comparison
// runs over the names' UTF-8 bytes, which is what GNU sees.
export function filevercmp(a: string, b: string): number {
  if (a === b) return 0
  for (const special of ['', '.', '..']) {
    if (a === special) return -1
    if (b === special) return 1
  }
  const aHidden = a.startsWith('.')
  const bHidden = b.startsWith('.')
  if (aHidden !== bHidden) return aHidden ? -1 : 1
  const ab = ENC.encode(a)
  const bb = ENC.encode(b)
  let result = verrevcmp(ab.subarray(0, versionPrefixLen(ab)), bb.subarray(0, versionPrefixLen(bb)))
  if (result === 0) result = verrevcmp(ab, bb)
  if (result === 0) result = compareBytes(ab, bb)
  return result
}

// The columns a name occupies, the key --sort=width compares: GNU
// measures the rendered width, so a wide character counts two and a
// combining mark none.
export function nameWidth(name: string): number {
  let width = 0
  for (const ch of name) width += charWidth(ch.codePointAt(0) ?? 0)
  return width
}

// The key `ls -X` compares first: the name from its last dot, empty for
// a name without one.
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

function primaryValue(entry: FileStat, sortBy: LsSortBy, timeKind: LsTimeKind): string | number {
  if (sortBy === 'time') return timeOf(entry, timeKind) ?? ''
  // A row whose stat failed sorts as 0, as GNU's zeroed stat does.
  return entry.extra[STAT_FAILED_KEY] === true ? 0 : contentSize(entry)
}

// GNU's -t/-S comparators fall back to the name when the timestamps or sizes
// tie, so the order is total. `-r` negates the whole comparison, tie-break
// included, which is why callers fold the sign into this comparator instead of
// reversing the finished array. -X and --sort=width are stable sorts over
// the name order too; -v is gnulib's version order.
function compareStats(
  a: FileStat,
  b: FileStat,
  sortBy: LsSortBy,
  timeKind: LsTimeKind,
  escape = false,
): number {
  if (sortBy === 'version') return filevercmp(a.name, b.name)
  if (sortBy === 'extension') {
    const byExt = compareCodePoints(extensionOf(a.name), extensionOf(b.name))
    if (byExt !== 0) return byExt
  } else if (sortBy === 'width') {
    const byWidth =
      nameWidth(escape ? escapeName(a.name) : a.name) -
      nameWidth(escape ? escapeName(b.name) : b.name)
    if (byWidth !== 0) return byWidth
  } else if (sortBy !== 'name' && sortBy !== 'none') {
    const av = primaryValue(a, sortBy, timeKind)
    const bv = primaryValue(b, sortBy, timeKind)
    // -t and -S list newest/largest first.
    if (av < bv) return 1
    if (av > bv) return -1
  }
  return compareCodePoints(a.name, b.name)
}

// -U keeps the listing order, and -r does not reverse it (GNU's -r
// reverses while sorting, and -U does not sort);
// --group-directories-first partitions the finished order, so the
// directories come first in every sort but -U, where GNU ignores it.
export function sortStats(
  stats: readonly FileStat[],
  sortBy: LsSortBy,
  reverse: boolean,
  timeKind: LsTimeKind = 'mtime',
  groupDirsFirst = false,
  escape = false,
): FileStat[] {
  let ordered: FileStat[]
  if (sortBy === 'none') {
    ordered = [...stats]
  } else {
    const sign = reverse ? -1 : 1
    ordered = [...stats].sort((a, b) => sign * compareStats(a, b, sortBy, timeKind, escape))
  }
  if (groupDirsFirst && sortBy !== 'none') {
    ordered = [
      ...ordered.filter((s) => s.type === FileType.DIRECTORY),
      ...ordered.filter((s) => s.type !== FileType.DIRECTORY),
    ]
  }
  return ordered
}

// A file operand whose readdir came back empty: backends without real
// directories (e.g. S3) list the "<file>/" prefix and find nothing rather than
// raising ENOTDIR. Return the stat only when it is a non-directory, so an empty
// directory still lists as empty. Mirrors Python ls `_file_entry`.
// The row of an operand that is no directory, null for a directory or a path
// nothing is at; a stat that fails other than by absence throws.
async function fileEntry(stat: Stat, path: PathSpec): Promise<FileStat | null> {
  try {
    const s = await stat(path)
    return s.type !== FileType.DIRECTORY ? asOperand(s, path) : null
  } catch (err) {
    if (!isMissError(err) && !isMissingPath(err)) throw err
    return null
  }
}

// GNU ls prints a file operand as given (`ls sub/x.txt` shows sub/x.txt,
// not x.txt); the row carries the operand spelling. `with` preserves
// every other field (mode/uid/gid/atime overlay attrs included), the
// mirror of Python `s.model_copy(update={"name": ...})`.
function asOperand(s: FileStat, path: PathSpec): FileStat {
  return s.with({ name: path.rawPath })
}

// The row for a child mount, carrying its real type.
//
// No backend can supply it: the parent's cannot see into the child mount,
// and the child's own answers its root with that mount's name for itself
// ('/'), which is why the row is renamed here the way the relay renames
// one. So the fact comes through the dispatcher, which routes to whichever
// mount owns the path.
//
// A mount root is not always a directory — every workspace mounts
// `/.bash_history` as a whole mount serving one file — and calling one a
// directory suffixes it with '/' under -F, renders it `drwxr-xr-x` under
// -l, and offers it to -R as something to descend. GNU lists a file that
// happens to be a mountpoint as an ordinary file row (pinned on coreutils
// 9.7 over a `mount --bind` of one file onto another). Directory is the
// fallback for a caller with no dispatcher, which is the only thing that
// absence can mean.
async function mountRow(
  directory: PathSpec,
  name: string,
  statPath: StatPath | null,
): Promise<FileStat> {
  if (statPath !== null) {
    const row = await statPath(`${rstripSlash(directory.virtual)}/${name}`)
    if (row !== null) return row.with({ name })
  }
  return new FileStat({ name, type: FileType.DIRECTORY })
}

// The row for an entry the listing named but its stat could not describe.
// GNU keeps it, since readdir is what named it, and `?` stands for every
// fact only the stat knows; its type is a directory's when the listing
// slash-marked it, and unknown otherwise.
function statFailedRow(entry: string): FileStat {
  const trimmed = rstripSlash(entry)
  return new FileStat({
    name: trimmed.slice(trimmed.lastIndexOf('/') + 1),
    type: entry.endsWith('/') ? FileType.DIRECTORY : FileType.FILE,
    extra: { [STAT_FAILED_KEY]: true },
  })
}

// Stat every name in a directory, plus the mounts below it. An entry whose
// stat fails keeps its row and never fails the whole directory, whatever the
// error: a dropped connection on a mount whose stat is a request costs that
// entry alone, as any failed stat does in GNU's gobble_file. It is reported,
// and the exit is 1, only when the listing prints something the stat
// supplies (`statNeeded`). One entry at a time, as GNU's lstat loop and
// find's walk go: on a mount that keeps no listing index each stat is a
// backend request, and firing a whole directory's worth together is a burst
// the backend may refuse. `spell` gives an entry's path as the operand
// spelled it, for a diagnostic. Mirrors Python ls `_stat_entries`.
async function listDir(
  readdir: Readdir,
  stat: Stat,
  dir: PathSpec,
  ctx: WalkOpts,
  warnings: LsWarning[],
  spell: (virtual: string) => string,
): Promise<{ stats: FileStat[]; structureOnly: boolean }> {
  const { all, links, childMounts } = ctx
  let entries: string[]
  let structureOnly = false
  try {
    entries = await readdir(dir)
  } catch (err) {
    // A directory whose own `.` and `..` did not resolve is not one the
    // namespace can owe children to.
    if (!isWalkError(err) || isDotWalkError(err) || (childMounts?.(dir.virtual) ?? []).length === 0)
      throw err
    // No backend serves it, but the namespace owes it children (a
    // nested mount, a link's ancestors), so the dispatcher lists it as a
    // directory and ls must agree: the merge below renders those rows
    // from an empty backend listing.
    entries = []
    structureOnly = true
  }
  const entryStat: Stat = (p: PathSpec) => followedStat(stat, ctx.deref ? links : null, p)
  const prefix = mountPrefixOf(dir.virtual, dir.vfsPath)
  const stats: FileStat[] = []
  for (const entry of entries) {
    let s: FileStat
    try {
      s = await entryStat(childSpec(entry, prefix))
    } catch (err) {
      if (!isEntryError(err)) throw err
      const row = statFailedRow(entry)
      stats.push(row)
      if (!all && row.name.startsWith('.')) continue
      if (!ctx.statNeeded) continue
      // An entry below an operand is never a command-line arg.
      warnings.push({
        message: `ls: cannot access '${spell(rstripSlash(entry))}': ${failureText(err)}`,
        serious: false,
      })
      continue
    }
    stats.push(s)
    if (
      ctx.deref &&
      ctx.statNeeded &&
      s.type === FileType.SYMLINK &&
      (all || !s.name.startsWith('.'))
    ) {
      // -L reports what each link leads to; one leading nowhere is listed
      // by name and reported, a minor problem (exit 1), where the listing
      // stats an entry at all.
      warnings.push({
        message: `ls: cannot access '${spell(rstripSlash(entry))}': ${posixPhrase('ENOENT')}`,
        serious: false,
      })
    }
  }
  const seen = new Set(stats.map((s) => s.name))
  for (const name of childMounts?.(dir.virtual) ?? []) {
    if (seen.has(name)) continue
    seen.add(name)
    stats.push(await mountRow(dir, name, ctx.statPath))
  }
  return {
    stats: all ? stats : stats.filter((s) => !s.name.startsWith('.')),
    structureOnly,
  }
}

// The row for an operand that is itself a symlink, else null, named with the
// operand's own spelling like every other ls row. Renaming a link row copies
// every field, not a hand-picked few: a link carries real ownership (chown -h
// writes it), and listing the fields by hand silently drops whatever the node
// grows next.
function linkRow(path: PathSpec, links: LinkView | null): FileStat | null {
  const row = links?.statAt(path.virtual) ?? null
  if (row === null) return null
  return row.with({ name: path.rawPath })
}

// The row `ls -d` prints for one operand, or why it cannot. Mirrors Python's
// _operand_row.
async function operandRow(
  path: PathSpec,
  stat: Stat,
  links: LinkView | null,
  childMounts: ChildMounts | null,
): Promise<FileStat | LsWarning> {
  const link = linkRow(path, links)
  if (link !== null) return link
  try {
    // GNU ls -d prints the operand as given.
    return asOperand(await stat(path), path)
  } catch (err) {
    if (!isWalkError(err)) throw err
    if (!isDotWalkError(err) && (childMounts?.(path.virtual) ?? []).length > 0) {
      // No backend serves it, but the namespace owes it children,
      // so the dispatcher stats it as a directory and -d must print the
      // same row.
      return new FileStat({ name: path.rawPath, type: FileType.DIRECTORY })
    }
    return { message: `ls: cannot access '${path.rawPath}': ${errText(err)}`, serious: true }
  }
}

// List one operand and report whether it turned out to be a directory.
// `chain` holds, under -RL, the directories open above this one, each as the
// path it resolves to; `spell` gives a path below the operand as the operand
// spelled it, null at the operand itself.
async function probeOperand(
  readdir: Readdir,
  stat: Stat,
  path: PathSpec,
  ctx: WalkOpts,
  warnings: LsWarning[],
  commandLineArg: boolean,
  chain: readonly string[] = [],
  spell: ((virtual: string) => string) | null = null,
): Promise<Operand> {
  const spelled = spell ?? ((virtual: string) => respellOne(virtual, path.virtual, path.rawPath))
  const links = ctx.links
  const ownStat: Stat = (p: PathSpec) => followedStat(stat, ctx.deref ? links : null, p)
  if (path.walkError === null && (commandLineArg || !ctx.deref)) {
    // The table's readdir opens what a link leads to, as opendir(3) does,
    // so a link the line left unresolved is asked first: the router
    // already resolved every one this ls follows.
    const link = linkRow(path, ctx.links)
    if (link !== null) return { path, row: link, groups: [] }
  }
  let stats: FileStat[]
  let structureOnly = false
  try {
    const listed = await listDir(readdir, stat, path, ctx, warnings, spelled)
    stats = listed.stats
    structureOnly = listed.structureOnly
  } catch (err) {
    if (!isWalkError(err)) throw err
    // The operand did not resolve, so neither the path it simplifies to
    // nor a link standing there answers for it. A command-line link whose
    // stat loops is the exception: GNU lstats it then and lists the link
    // itself, unless -L or -H asked for the target (ls.c's gobble_file,
    // coreutils 9.7).
    const walkRefused = isDotWalkError(err)
    const looped = walkRefused && (err as { code?: string }).code === 'ELOOP'
    let row: FileStat | null = null
    let refused: unknown = null
    if (!walkRefused) {
      try {
        row = await fileEntry(ownStat, path)
      } catch (statErr) {
        if (!isWalkError(statErr)) throw statErr
        refused = statErr
      }
    }
    if (row !== null) return { path, row, groups: [] }
    const link = looped && commandLineArg && !ctx.followArgs ? linkRow(path, links) : null
    if (link !== null) return { path, row: link, groups: [] }
    // GNU stats an operand before it opens one (ls.c's gobble_file, coreutils
    // 9.7): a stat that fails is what it names, and a directory it may not
    // read is worded apart, the entry being there.
    const verb = refused === null && isEacces(err) ? 'cannot open directory' : 'cannot access'
    warnings.push({
      message: `ls: ${verb} '${path.rawPath}': ${errText(refused ?? err)}`,
      serious: commandLineArg,
    })
    return { path, row: null, groups: [] }
  }
  if (stats.length === 0 && !structureOnly) {
    let row: FileStat | null = null
    try {
      row = await fileEntry(ownStat, path)
    } catch (err) {
      if (!isWalkError(err)) throw err
      console.debug(`ls: ${path.virtual} listed empty, its stat refused: ${String(err)}`)
    }
    if (row !== null) return { path, row, groups: [] }
  }
  const entries = sortStats(
    stats,
    ctx.sortBy,
    ctx.reverse,
    ctx.timeKind,
    ctx.groupDirsFirst,
    ctx.escape,
  )
  const groups: [PathSpec, FileStat[]][] = [[path, entries]]
  if (ctx.recursive) {
    const real = ctx.deref && links !== null ? (virtual: string) => links.resolve(virtual) : null
    const open = real !== null && chain.length === 0 ? [real(path.virtual)] : chain
    for (const s of entries) {
      if (s.type !== FileType.DIRECTORY) continue
      const childPath = `${rstripSlash(path.virtual)}/${s.name}`
      if (ctx.mounts?.isRoot(childPath) ?? false) {
        // A nested mount's root. Its row belongs here, but its listing
        // is another backend's, which this walk cannot read: the
        // cross-mount fan-out renders that group.
        continue
      }
      let below = open
      if (real !== null) {
        // Under -L a directory is the one it resolves to, and one open
        // above this one is never listed again (exit 2).
        const here = real(childPath)
        if (open.includes(here)) {
          warnings.push({
            message: `ls: ${spelled(childPath)}: not listing already-listed directory`,
            serious: true,
          })
          continue
        }
        below = [...open, here]
      }
      const child = await probeOperand(
        readdir,
        stat,
        childSpec(childPath, mountPrefixOf(path.virtual, path.vfsPath)),
        ctx,
        warnings,
        false,
        below,
        spelled,
      )
      // Appended one at a time: `push(...child.groups)` would spread the
      // child's whole pre-order subtree as call arguments and overflow the
      // engine's argument limit on a very wide tree. Mirrors Python's
      // `groups.extend(child.groups)`.
      for (const group of child.groups) groups.push(group)
    }
  }
  return { path, row: null, groups }
}

// Sort row for one operand, named with the operand's own spelling.
async function operandKey(operand: Operand, sortBy: LsSortBy, stat: Stat): Promise<FileStat> {
  if (operand.row !== null) return operand.row
  if (sortBy === 'name') {
    return new FileStat({ name: operand.path.rawPath, type: FileType.DIRECTORY })
  }
  try {
    return asOperand(await stat(operand.path), operand.path)
  } catch (err) {
    if (!isWalkError(err)) throw err
    // The stat only supplies a sort key; an operand that cannot be statted
    // sorts as if it had none rather than failing the listing.
    return new FileStat({ name: operand.path.rawPath, type: FileType.DIRECTORY })
  }
}

async function sortOperands(
  operands: readonly Operand[],
  sortBy: LsSortBy,
  reverse: boolean,
  stat: Stat,
  timeKind: LsTimeKind,
  escape: boolean,
): Promise<Operand[]> {
  const keyed: { key: FileStat; operand: Operand }[] = []
  for (const operand of operands) {
    keyed.push({ key: await operandKey(operand, sortBy, stat), operand })
  }
  if (sortBy === 'none') return keyed.map((k) => k.operand)
  const sign = reverse ? -1 : 1
  keyed.sort((a, b) => sign * compareStats(a.key, b.key, sortBy, timeKind, escape))
  return keyed.map((k) => k.operand)
}

/** The ls flag bag, parsed once. */
export interface LsFlags {
  readonly long: boolean
  readonly all: boolean
  readonly showDotEntries: boolean
  readonly human: boolean
  readonly reverse: boolean
  readonly indicator: LsIndicator
  readonly recursive: boolean
  readonly listDir: boolean
  readonly deref: boolean
  readonly followArgs: boolean
  readonly sortBy: LsSortBy
  readonly timeKind: LsTimeKind
  readonly groupDirsFirst: boolean
  readonly columns: LsColumns
  readonly escape: boolean
  readonly hyperlink: boolean
}

// GNU's own `sort_args` (coreutils 9.7), in its own order, which is what
// `--sort=x` lists back. 9.7 added `name`, the order no `--sort` at all
// means, so `--sort=n` is ambiguous between it and `none`.
const SORT_WORDS: Readonly<Record<string, LsSortBy>> = {
  none: 'none',
  size: 'size',
  time: 'time',
  version: 'version',
  extension: 'extension',
  name: 'name',
  width: 'width',
}
const SORT_FLAGS: Readonly<Record<string, LsSortBy>> = {
  t: 'time',
  S: 'size',
  X: 'extension',
  v: 'version',
  U: 'none',
}
const TIME_GROUPS: readonly (readonly string[])[] = [
  ['atime', 'access', 'use'],
  ['ctime', 'status'],
  ['mtime', 'modification'],
  ['birth', 'creation'],
]
const TIME_KINDS: Readonly<Record<string, LsTimeKind>> = {
  atime: 'atime',
  ctime: 'ctime',
  mtime: 'mtime',
  birth: 'birth',
}
// GNU's `when` words, shared by --hyperlink and --classify.
const WHEN_GROUPS: readonly (readonly string[])[] = [
  ['always', 'yes', 'force'],
  ['never', 'no', 'none'],
  ['auto', 'tty', 'if-tty'],
]
const INDICATOR_GROUPS: readonly (readonly string[])[] = [
  ['none'],
  ['slash'],
  ['file-type'],
  ['classify'],
]
// The four spellings of an indicator style; the last one typed wins.
const INDICATOR_DESTS = ['classify', 'file_type', 'p', 'indicator_style'] as const
// The three spellings of a command-line link policy; the last one wins.
const DEREF_DESTS = [
  'dereference',
  'dereference_command_line',
  'dereference_command_line_symlink_to_dir',
] as const

// GNU's ARGMATCH refusal for an option whose values have aliases, listed
// one group per line (--time, --hyperlink); exit 1, as ls answers it. The
// value goes in as typed -- the shared renderer escapes it.
function groupedArgumentError(
  option: string,
  value: string,
  groups: readonly (readonly string[])[],
  kind: WordRefusalKind,
): UsageError {
  return wordRefusalError('ls', option, value, groups, 1, kind)
}

const WORD_OPTIONS: Readonly<Record<string, [string, readonly (readonly string[])[]]>> = {
  sort: ['--sort', Object.keys(SORT_WORDS).map((word) => [word])],
  time: ['--time', TIME_GROUPS],
  hyperlink: ['--hyperlink', WHEN_GROUPS],
  color: ['--color', WHEN_GROUPS],
  classify: ['--classify', WHEN_GROUPS],
  indicator_style: ['--indicator-style', INDICATOR_GROUPS],
}

/**
 * Refuse a bad option value where GNU does: while it reads the line.
 *
 * GNU checks each value inside its getopt loop, so the first bad one typed is
 * the one it names, and a later good value of the same option does not rescue
 * an earlier bad one (coreutils 9.7: `ls --sort=bogus --sort=size` and
 * `ls --time=x --sort=y` both refuse, the second naming `--time`).
 * `--time-style` is the exception: GNU reads only its last value, after the
 * loop.
 */
function checkOptionWords(fl: FlagView): void {
  for (const [dest, value] of fl.occurrences(...Object.keys(WORD_OPTIONS), 'block_size')) {
    if (value === true) continue
    const word = String(value)
    if (dest === 'block_size') {
      const parsed = parseBlockSize(word)
      if (typeof parsed === 'string') throw new UsageError(blockSizeError(word, parsed), 2)
      continue
    }
    const entry = WORD_OPTIONS[dest]
    if (entry === undefined) continue
    const [option, groups] = entry
    const match = matchWord(word, groups)
    if (!match.matched) throw groupedArgumentError(option, word, groups, match.kind)
  }
}

// The sort key the line asked for, last spelling winning, and whether it
// asked at all.
function sortFlag(fl: FlagView): [LsSortBy, boolean] {
  const typed = fl.typedOrder('t', 'S', 'X', 'v', 'U', 'sort')
  const last = typed[typed.length - 1]
  if (last === undefined) return ['name', false]
  if (last !== 'sort') return [SORT_FLAGS[last] ?? 'name', true]
  const word = fl.asStr('sort') ?? ''
  const words = Object.keys(SORT_WORDS)
  const match = matchWord(word, words)
  if (!match.matched) {
    throw wordRefusalError('ls', '--sort', word, words, 1, match.kind)
  }
  return [SORT_WORDS[match.word] ?? 'name', true]
}

// Which timestamp -c, -u or --time asked for, last one winning.
function timeFlag(fl: FlagView): LsTimeKind {
  const typed = fl.typedOrder('c', 'u', 'time')
  const last = typed[typed.length - 1]
  if (last === undefined) return 'mtime'
  if (last === 'c') return 'ctime'
  if (last === 'u') return 'atime'
  const word = fl.asStr('time') ?? ''
  const match = matchWord(word, TIME_GROUPS)
  if (!match.matched) throw groupedArgumentError('--time', word, TIME_GROUPS, match.kind)
  return TIME_KINDS[match.word] ?? 'mtime'
}

// --time-style, validated the way GNU words it (exit 2). A posix- prefix
// short-circuits the whole option: GNU's loop strips each one and, outside
// a hard LC_TIME locale, jumps straight to the locale style without looking
// at what follows. mirage has no other locale, so every posix- spelling is
// the locale style and none of them is ever refused -- measured on
// coreutils 9.4, where `posix-full-iso`, `posix-l`, `posix-zzz`, `posix-`
// and `posix-+%H:%M` all exit 0 and all print what `locale` prints. The
// matcher therefore has to run after that check, not before: the remainder
// is not a candidate word at all.
function timeStyleFlag(fl: FlagView): string {
  const style = fl.asStr('time_style')
  if (style === undefined) return 'locale'
  if (style.startsWith('posix-')) return 'locale'
  if (style.startsWith('+')) return style
  const match = matchWord(style, LS_TIME_STYLES)
  if (match.matched) return match.word
  // ls hand-writes this block rather than letting argmatch print
  // `time_style_args`, so it is the one ARGMATCH refusal in the repo whose
  // candidates are neither quoted nor a subset of the words it accepts --
  // and the one that exits 2, ls's own `usage (LS_FAILURE)`. The first line
  // is still argmatch's, so `--time-style=lo` spans long-iso and locale and
  // reads `ambiguous argument 'lo'`.
  throw new UsageError(
    `${wordRefusalLine('ls', 'time style', style, match.kind)}\n` +
      'Valid arguments are:\n' +
      '  - [posix-]full-iso\n' +
      '  - [posix-]long-iso\n' +
      '  - [posix-]iso\n' +
      '  - [posix-]locale\n' +
      "  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n" +
      usageHint('ls'),
    2,
  )
}

// Whether --hyperlink asked for OSC 8 links: always does, never does
// not, and auto does not either, since command output here is never a
// terminal.
function hyperlinkFlag(fl: FlagView): boolean {
  const raw: unknown = fl.raw('hyperlink')
  if (raw === undefined || raw === null || raw === false) return false
  if (raw === true) return true
  const word = typeof raw === 'string' ? raw : ''
  const match = matchWord(word, WHEN_GROUPS)
  if (!match.matched) {
    throw groupedArgumentError('--hyperlink', word, WHEN_GROUPS, match.kind)
  }
  return match.word === 'always'
}

// The style one indicator option asks for, checked as GNU checks it: -F and a
// bare --classify classify; --classify=WHEN does for `always` and never
// otherwise, since output here is never a terminal. A refused value is GNU's
// ARGMATCH refusal, exit 1. Mirrors Python's _indicator_word.
function indicatorWord(dest: string, raw: unknown): LsIndicator {
  if (dest === 'p') return 'slash'
  if (dest === 'file_type') return 'file-type'
  if (dest === 'classify' && raw === true) return 'classify'
  const word = typeof raw === 'string' ? raw : ''
  const option = dest === 'classify' ? '--classify' : '--indicator-style'
  const groups = dest === 'classify' ? WHEN_GROUPS : INDICATOR_GROUPS
  const match = matchWord(word, groups)
  if (!match.matched) throw groupedArgumentError(option, word, groups, match.kind)
  if (dest === 'indicator_style') return match.word as LsIndicator
  return match.word === 'always' ? 'classify' : 'none'
}

/**
 * The indicator style a line asks for: the last of -F/--classify[=WHEN], -p,
 * --file-type and --indicator-style wins, and every one is checked on the
 * way, as GNU checks each value while it reads the options (coreutils 9.7).
 * Mirrors Python's indicator_flag.
 */
export function indicatorFlag(fl: FlagView): LsIndicator {
  let style: LsIndicator = 'none'
  for (const [dest, raw] of fl.occurrences(...INDICATOR_DESTS)) {
    style = indicatorWord(dest, raw)
  }
  return style
}

/**
 * Which command-line links GNU ls resolves before it lists them. ls.c settles
 * it once: the last of -L, -H and --dereference-command-line-symlink-to-dir
 * wins, and with none of them -d, a long format or the classify style resolve
 * no link while anything else resolves one that leads to a directory
 * (coreutils 9.7). A value the command refuses leaves the style unclassified,
 * since that line fails before it lists anything. Mirrors Python's link_mode.
 */
export function linkMode(fl: FlagView): LsLinkMode {
  const typed = fl.typedOrder(...DEREF_DESTS)
  const last = typed.at(-1)
  if (last !== undefined) {
    return last === 'dereference_command_line_symlink_to_dir' ? 'directory' : 'all'
  }
  const long = ['args_l', 'g', 'o', 'numeric_uid_gid'].some((dest) => fl.asBool(dest))
  let classify = false
  try {
    classify = indicatorFlag(fl) === 'classify'
  } catch (err) {
    // The command refuses this line itself, before it lists anything.
    if (!(err instanceof UsageError)) throw err
  }
  return fl.asBool('directory') || long || classify ? 'none' : 'directory'
}

// Parse the ls flag bag once into a frozen struct. GNU's rules that are
// easy to get wrong: -g, -o and -n imply the long format, and -1 never
// undoes it in either order (GNU ignores -1 beside -l, and with no
// terminal there are never columns, so -1 has nothing else to do); -n prints the
// same columns as -l, because a mirage owner is already the id (an agent,
// a profile) and never a name looked up from one; the last of -t, -S, -X,
// -v, -U and --sort wins, as does the last of -c, -u and --time; and -c or
// -u with neither -l nor a sort sorts by that time; and the later of -h
// and --block-size wins. Throws UsageError for
// a value GNU refuses, with GNU's exit status for that option.
// GNU's three --block-size refusals, worded as ls words them. Measured on
// coreutils 9.7: `ls: invalid --block-size argument 'x'`, `ls: invalid
// suffix in --block-size argument '1x'` and `ls: --block-size argument
// '99999999999999999999' too large`. The word is quoted but NOT escaped,
// which is GNU's own split (xstrtol's fatal path prints the argument as is,
// where argmatch's runs it through quote()): `ls --block-size=1é` reports
// the two UTF-8 bytes intact.
function blockSizeError(text: string, refusal: BlockSizeRefusal): string {
  const quoted = `'${text}'`
  if (refusal === 'too large') return `ls: --block-size argument ${quoted} too large`
  if (refusal === 'invalid suffix') return `ls: invalid suffix in --block-size argument ${quoted}`
  return `ls: invalid --block-size argument ${quoted}`
}

export function parseFlags(fl: FlagView): LsFlags {
  checkOptionWords(fl)
  const [askedSort, sortedExplicitly] = sortFlag(fl)
  const timeKind = timeFlag(fl)
  const noOwner = fl.asBool('g')
  const noGroup = fl.asBool('o')
  const long = fl.asBool('args_l') || noOwner || noGroup || fl.asBool('numeric_uid_gid')
  const sortBy: LsSortBy = !sortedExplicitly && timeKind !== 'mtime' && !long ? 'time' : askedSort
  const blockText = fl.asStr('block_size')
  let blockSize = null
  if (blockText !== undefined) {
    const parsedBlock = parseBlockSize(blockText)
    if (typeof parsedBlock === 'string')
      throw new UsageError(blockSizeError(blockText, parsedBlock), 2)
    blockSize = parsedBlock
    // The later of -h and --block-size wins (GNU: `--block-size=1 -h`
    // prints 1.5K, `-h --block-size=1` prints 1536); the value is still
    // checked either way.
    if (fl.typedOrder('human_readable', 'block_size').at(-1) === 'human_readable') blockSize = null
  }
  const columns: LsColumns = Object.freeze({
    owner: !noOwner,
    group: !noGroup,
    inode: fl.asBool('inode'),
    context: fl.asBool('context'),
    timeKind,
    timeStyle: timeStyleFlag(fl),
    blockSize,
  })
  return Object.freeze({
    long,
    all: fl.asBool('all') || fl.asBool('almost_all'),
    showDotEntries: fl.asBool('all'),
    human: fl.asBool('human_readable'),
    reverse: fl.asBool('reverse'),
    indicator: indicatorFlag(fl),
    recursive: fl.asBool('recursive'),
    listDir: fl.asBool('directory'),
    // -L alone dereferences what a listing finds; -H and its sibling stop at
    // the command line, and the last of the three wins.
    deref: fl.typedOrder(...DEREF_DESTS).at(-1) === 'dereference',
    followArgs: linkMode(fl) === 'all',
    sortBy,
    timeKind,
    groupDirsFirst: fl.asBool('group_directories_first'),
    columns,
    hyperlink: hyperlinkFlag(fl),
    escape: fl.asBool('escape'),
  })
}

// Whether GNU's ls would stat a listed entry to print this listing, which
// is when a failed stat reaches stderr: the long format, a time or size
// sort, -i, -Z and --hyperlink read the stat (GNU's format_needs_stat), and
// -R, -F and --group-directories-first read the type (format_needs_type),
// which a mirage listing never carries, as a readdir without d_type does
// not. A plain listing prints the names readdir gave and nothing else.
function statNeeded(flags: LsFlags): boolean {
  return (
    flags.long ||
    flags.sortBy === 'time' ||
    flags.sortBy === 'size' ||
    flags.columns.inode ||
    flags.columns.context ||
    flags.hyperlink ||
    flags.recursive ||
    flags.indicator !== 'none' ||
    flags.groupDirsFirst
  )
}

function finish(lines: string[], warnings: readonly LsWarning[]): CommandFnResult {
  const out: ByteSource = formatRecords(lines)
  const exitCode = exitStatusFor(warnings)
  if (warnings.length > 0) {
    const stderr = formatRecords(warnings.map((w) => w.message))
    return [out, new IOResult({ stderr, exitCode })]
  }
  return [out, new IOResult({ exitCode })]
}

// `statPath` stats a mount root or dot entry across mounts; the cross-mount relay passes none.
export async function lsGeneric(
  paths: PathSpec[],
  ctx: Context,
  readdir: Readdir,
  stat: Stat,
  statPath: StatPath | null = vfsStatPath(ctx.vfs) ?? null,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, specOf('ls'))
  const targets: PathSpec[] =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: ctx.cwd.virtual,
            directory: ctx.cwd.virtual,
            resolved: false,
            vfsPath: mountKey(ctx.cwd.virtual, ctx.mountPrefix ?? ''),
          }),
        ]
  const flags = parseFlags(fl)
  const {
    long,
    all,
    human,
    reverse,
    indicator,
    recursive,
    sortBy,
    timeKind,
    groupDirsFirst,
    deref,
    followArgs,
  } = flags
  const listDirItself = flags.listDir
  const links = linksOf(ctx) ?? null
  const identity = identityOf(ctx)
  const render: RenderOpts = {
    long,
    human,
    indicator,
    identity,
    columns: flags.columns,
    escape: flags.escape,
  }
  const warnings: LsWarning[] = []
  const lines: string[] = []
  const childMounts: ChildMounts | null =
    ctx.vfs === undefined ? null : (dir: string) => owedNames(ctx.vfs, dir)

  if (listDirItself) {
    // -d turns every operand into a plain row, sorted together and printed
    // with no headers.
    const collected: { row: FileStat; href: string }[] = []
    for (const p of targets) {
      const row = await operandRow(p, stat, links, childMounts)
      if (row instanceof FileStat) collected.push({ row, href: p.virtual })
      else warnings.push(row)
    }
    const byRow = new Map(collected.map((c) => [c.row, c.href]))
    const rows =
      collected.length > 1
        ? sortStats(
            collected.map((c) => c.row),
            sortBy,
            reverse,
            timeKind,
            groupDirsFirst,
            flags.escape,
          )
        : collected.map((c) => c.row)
    const rowPaths = rows.map((r) => byRow.get(r) ?? '')
    appendListing(
      rows,
      render,
      lines,
      flags.hyperlink ? rowPaths : null,
      await linkTargets(rows, rowPaths, links, render),
    )
    return finish(lines, warnings)
  }

  const walkOpts: WalkOpts = {
    escape: flags.escape,
    all,
    sortBy,
    reverse,
    timeKind,
    groupDirsFirst,
    recursive,
    links,
    deref,
    followArgs,
    childMounts,
    mounts: mountsOf(ctx) ?? null,
    statPath,
    statNeeded: statNeeded(flags),
  }
  const probed: Operand[] = []
  for (const p of targets) {
    probed.push(await probeOperand(readdir, stat, p, walkOpts, warnings, true))
  }
  const operands =
    probed.length > 1
      ? await sortOperands(probed, sortBy, reverse, stat, timeKind, flags.escape)
      : probed

  // GNU names every listed directory once there is more than one operand
  // (or under -R); a lone directory operand is listed bare.
  const headed = recursive || targets.length > 1
  const rowed = operands.filter((o) => o.row !== null)
  const rows = rowed.flatMap((o) => (o.row !== null ? [o.row] : []))
  const rowPaths = rowed.map((o) => o.path.virtual)
  appendListing(
    rows,
    render,
    lines,
    flags.hyperlink ? rowPaths : null,
    await linkTargets(rows, rowPaths, links, render),
  )
  let printed = rows.length > 0
  for (const operand of operands) {
    for (const [dirSpec, group] of operand.groups) {
      let entries = group
      if (flags.showDotEntries) {
        const dots: FileStat[] = []
        const prefix = mountPrefixOf(dirSpec.virtual, dirSpec.vfsPath)
        for (const name of ['.', '..']) {
          const target = posixNormpath(`${dirSpec.virtual}/${name}`)
          let row = new FileStat({ name, type: FileType.DIRECTORY })
          // Only the namespace can stat a parent outside this mount.
          // Without `statPath`, keep the synthetic directory row.
          if (statNeeded(flags) && (statPath !== null || underPath(target, prefix))) {
            try {
              const found =
                statPath !== null ? await statPath(target) : await stat(childSpec(target, prefix))
              if (found !== null) row = found.with({ name })
            } catch (err) {
              if (!isWalkError(err)) throw err
              row = statFailedRow(name)
              warnings.push({
                message: `ls: cannot access '${name}': ${errText(err)}`,
                serious: false,
              })
            }
          }
          dots.push(row)
        }
        entries = sortStats(
          [...dots, ...entries],
          sortBy,
          reverse,
          timeKind,
          groupDirsFirst,
          flags.escape,
        )
      }
      if (headed) {
        if (printed) lines.push('')
        const header = respellOne(dirSpec.virtual, operand.path.virtual, operand.path.rawPath)
        lines.push(`${flags.escape ? escapeName(header) : header}:`)
      }
      // GNU 9.7 prints allocated blocks; VFS has no allocation metadata.
      if (long) lines.push(entries.length > 0 ? 'total ?' : 'total 0')
      const entryPaths = entries.map((e) => `${rstripSlash(dirSpec.virtual)}/${e.name}`)
      appendListing(
        entries,
        render,
        lines,
        flags.hyperlink ? entryPaths : null,
        await linkTargets(entries, entryPaths, links, render),
      )
      printed = true
    }
  }

  return finish(lines, warnings)
}
