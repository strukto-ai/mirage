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
import { atOffsets, say } from '../utils/operands.ts'
import { IOResult } from '../../../io/types.ts'
import {
  LINK_TARGET_KEY,
  FileStat,
  FileType,
  Follow,
  LineFacts,
  PathSpec,
  type LsFormat,
  type LsIndicator,
  type LsLinkMode,
  type LsSortBy,
  type JsonValue,
  type LsTimeKind,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { ChildMounts, LinkView, MountView, StatPath } from '../../../view/types.ts'
import {
  STAT_FAILED_KEY,
  type BlockSize,
  blockSizeOf,
  type LsColumns,
  formatLsLong,
  lsName,
  lsPrefix,
  timeOf,
} from '../utils/formatting.ts'
import { UsageError } from '../../errors.ts'
import { isEntryError } from '../../../errors/classify.ts'
import { identityOf, type Identity } from '../utils/identity.ts'
import {
  fsStrerror,
  isDotWalkError,
  isEacces,
  isMissError,
  isMissingPath,
  isWalkError,
  strerrorOf,
} from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { followedStat } from '../../../view/namespace_view.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { respellOne, posixNormpath } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { contentSize } from '../../../utils/stat_view.ts'
import { quoteName } from '../../../utils/quote.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { textWidth } from '../../../utils/width.ts'
import { linksOf, mountsOf, owedNames } from '../utils/links.ts'
import { vfsStatPath } from '../utils/paths.ts'
import { WalkBudget } from '../utils/tree.ts'
import { openStream } from '../../../rs/stream.ts'
import { concat } from '../../../utils/bytes.ts'
import { scan, scanned } from '../../../rs/scan.ts'
import { decodeText, encodeText, textView } from '../../../shell/bytes.ts'
import { engineConfig } from './sort.ts'

export const LS_OK = 0
export const LS_MINOR_PROBLEM = 1
export const LS_FAILURE = 2

// How a name prints under the line's quoting style.
type Quote = (name: string) => string

// One diagnostic plus how serious GNU ls considers it: `serious` marks a
// failure on a command-line operand (exit 2); everything met while listing
// or recursing below an operand is a minor problem (exit 1).
interface LsWarning {
  message: string
  serious: boolean
}

interface WalkOpts {
  // How a name prints, whose width --sort=width compares; null for as it is.
  quote: Quote | null
  // The patterns of -I, -B and --hide; a name one matches is left out
  // unstatted.
  ignore: readonly string[]
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
  // Under -R, the entries the walk of this operand may still list; a
  // directory past it is listed in its parent but not opened.
  budget?: WalkBudget
}

// One ls operand once its kind is known. `row` is set when the operand is not
// a directory: GNU prints those first, as one block with no header. `groups`
// holds the operand's own [dir, entries] listing; under -R what lies below is
// walked as it prints. Both empty means the operand could not be accessed.
// `notes` holds a directory the operand could not list, with the number of
// groups listed before it: GNU reports one where its listing would have
// printed.
interface Operand {
  readonly path: PathSpec
  readonly row: FileStat | null
  readonly groups: [PathSpec, FileStat[]][]
  readonly notes?: readonly (readonly [number, LsWarning])[]
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
 * The mark GNU appends to a name for a style (coreutils 9.7). A directory is
 * `/` in every style but none; `slash` marks nothing else. A link is `@` and a FIFO `|`; an executable regular file is
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
  quote: Quote | null
  // The quoting style and format line bare names up with quoted ones.
  align: boolean
  layout: LsFormat
  long: boolean
  width: number | null
  tabsize: number
  human: boolean
  indicator: LsIndicator
  identity: Identity
  columns: LsColumns
}

// What a quoted name opens with.
const QUOTES = ["'", '"', '\u2018']

// The name column quoted, lined up and hyperlinked, null when every name
// prints as it is. Where `align` asks and a name of the group is quoted,
// every bare one takes a space before it, so the names line up past the
// opening quotes. A lined-up name keeps its quotes outside its hyperlink; any
// other name is linked whole, quotes and all. Mirrors Python's
// _decorated_names.
function decoratedNames(
  stats: readonly FileStat[],
  hrefs: readonly string[] | null,
  long: boolean,
  quote: Quote | null,
  align: boolean,
): string[] | null {
  if (hrefs === null && quote === null) return null
  const quoted = stats.map((s) => (quote === null ? s.name : quote(s.name)))
  const opened = quoted.map((q) => quote !== null && QUOTES.some((mark) => q.startsWith(mark)))
  const spaced = align && opened.some(Boolean)
  return stats.map((s, i) => {
    let name = quoted[i] ?? s.name
    if (hrefs !== null) {
      const href = hrefs[i] ?? ''
      name =
        spaced && opened[i] === true
          ? name.slice(0, 1) + hyperlinked(name.slice(1, -1), href) + name.slice(-1)
          : hyperlinked(name, href)
    }
    if (spaced && opened[i] !== true) name = ' ' + name
    const target = s.extra[LINK_TARGET_KEY]
    if (long && s.type === FileType.SYMLINK && typeof target === 'string')
      name += ' -> ' + (quote === null ? target : quote(target))
    return name
  })
}

/** Whether -I, -B or --hide leaves a listed name out: a pattern matches it
 * whole, a leading dot only where the pattern spells one. Mirrors Python's
 * ignored. */
export function ignored(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => fnmatch(name, pattern, false, true))
}

/** Short rows as their format lays them out: in -C or -x columns or -m's
 * comma list by mirage-rs, else one to a line. `width` null is no limit and
 * `tabsize` 0 pads with spaces only. Mirrors Python's laid_out. */
export async function laidOut(
  rows: string[],
  layout: LsFormat,
  width: number | null,
  tabsize: number,
): Promise<string[]> {
  if (layout === 'single-column' || layout === 'verbose' || rows.length === 0) return rows
  const stream = await openStream('ls_columns', { format: layout, width, tabsize })
  const out: Uint8Array[] = []
  try {
    out.push(stream.feed(concat(rows.map((row) => encodeText(`${row}\0`)))), stream.finish())
  } finally {
    stream.close()
  }
  const lines = decodeText(concat(out)).split('\n')
  lines.pop()
  return lines
}

async function renderGroup(
  stats: readonly FileStat[],
  render: RenderOpts,
  lines: string[],
  hrefs: readonly string[] | null = null,
  targets: readonly (FileStat | null)[] = [],
): Promise<void> {
  const names = decoratedNames(stats, hrefs, render.long, render.quote, render.align)
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
  const rows = stats.map((s, i) => formatSimple(s, render.indicator, render.columns, names?.[i]))
  for (const line of await laidOut(rows, render.layout, render.width, render.tabsize)) {
    lines.push(line)
  }
}

const ENC = new TextEncoder()
// A name may start with U+FEFF, which a default decoder drops from the front
// of what it decodes.
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

// GNU 9.7's `ls -v` lists names in the order `sort -zV` prints them, ties
// broken by bytes as sort's last resort does (1,500 random directories
// agreed), so the names go through mirage-rs's sort with one version key.
// A run holds every name, so the sort writes one run and never merges. Read
// once, on the first `ls -v`. Mirrors _version_sort in ls.py.
let versionSortConfig: Readonly<Record<string, JsonValue>> | null = null

function versionSort(): Readonly<Record<string, JsonValue>> {
  versionSortConfig ??= {
    ...engineConfig(
      scan('sort', [
        ['version_sort', ''],
        ['zero_terminated', ''],
      ]),
    ),
    mode: 'sort',
    run_bytes: Number.MAX_SAFE_INTEGER,
  }
  return versionSortConfig
}

/**
 * Indices of `names` (none holding a NUL) in `ls -v` order, each once;
 * equal names keep their input order. Mirrors sort_by_version in ls.py.
 */
export async function sortByVersion(names: readonly string[]): Promise<number[]> {
  const places = new Map<string, number[]>()
  names.forEach((name, index) => {
    const key = DEC.decode(ENC.encode(name))
    const queue = places.get(key)
    if (queue === undefined) places.set(key, [index])
    else queue.push(index)
  })
  const stream = await openStream('sort', versionSort())
  const out: Uint8Array[] = []
  try {
    out.push(stream.feed(ENC.encode(names.map((name) => `${name}\0`).join(''))), stream.finish())
    while (stream.busy()) out.push(stream.drain())
  } finally {
    stream.close()
  }
  const sorted = DEC.decode(concat(out)).split('\0')
  sorted.pop()
  return sorted.map((key) => {
    const index = places.get(key)?.shift()
    if (index === undefined) {
      throw new Error(`ls: the version sort returned a name it was not given: ${key}`)
    }
    return index
  })
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
// the name order too; -v goes through sortByVersion instead. `widths` holds
// each name's --sort=width key, measured once per sort as Python's key is.
function compareStats(
  a: FileStat,
  b: FileStat,
  sortBy: LsSortBy,
  timeKind: LsTimeKind,
  widths: ReadonlyMap<string, number>,
): number {
  if (sortBy === 'extension') {
    const byExt = compareCodePoints(extensionOf(a.name), extensionOf(b.name))
    if (byExt !== 0) return byExt
  } else if (sortBy === 'width') {
    const byWidth = (widths.get(a.name) ?? 0) - (widths.get(b.name) ?? 0)
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
export async function sortStats(
  stats: readonly FileStat[],
  sortBy: LsSortBy,
  reverse: boolean,
  timeKind: LsTimeKind = 'mtime',
  groupDirsFirst = false,
  quote: Quote | null = null,
): Promise<FileStat[]> {
  let ordered: FileStat[]
  if (sortBy === 'none') {
    ordered = [...stats]
  } else if (sortBy === 'version') {
    const order = await sortByVersion(stats.map((s) => s.name))
    ordered = order.flatMap((i) => stats[i] ?? [])
    if (reverse) ordered.reverse()
  } else {
    const sign = reverse ? -1 : 1
    const widths = new Map(
      sortBy === 'width'
        ? stats.map((s) => [s.name, textWidth(quote === null ? s.name : quote(s.name))] as const)
        : [],
    )
    ordered = [...stats].sort((a, b) => sign * compareStats(a, b, sortBy, timeKind, widths))
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
async function fileEntry(stat: StatFn, path: PathSpec): Promise<FileStat | null> {
  const s = await operandStat(stat, path)
  return s !== null && s.type !== FileType.DIRECTORY ? asOperand(s, path) : null
}

// An operand's stat, null for a path nothing is at; a stat that fails other
// than by absence throws. Mirrors Python ls `_operand_stat`.
async function operandStat(stat: StatFn, path: PathSpec): Promise<FileStat | null> {
  try {
    return await stat(path)
  } catch (err) {
    if (!isMissError(err) && !isMissingPath(err)) throw err
    return null
  }
}

// GNU ls prints a file operand as given (`ls sub/x.txt` shows sub/x.txt,
// not x.txt); the row carries the operand spelling. `with` preserves
// every other field (mode/uid/gid/atime overlay attrs included), the
// mirror of Python `replace(s, name=...)`.
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
// entry alone, as any failed stat does in a GNU listing. It is reported,
// and the exit is 1, only when the listing prints something the stat
// supplies (`statNeeded`). One entry at a time, as GNU ls and find stat
// them: on a mount that keeps no listing index each stat is a
// backend request, and firing a whole directory's worth together is a burst
// the backend may refuse. `spell` gives an entry's path as the operand
// spelled it, for a diagnostic. Mirrors Python ls `_stat_entries`.
async function statEntries(
  readdir: ReaddirFn<[path: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  dir: PathSpec,
  ctx: WalkOpts,
  warnings: LsWarning[],
  spell: (virtual: string) => string,
): Promise<{ stats: FileStat[]; structureOnly: boolean }> {
  const { all, links, childMounts } = ctx
  let entries: string[]
  let structureOnly = false
  try {
    const limit = ctx.budget?.listingLimit(dir.virtual) ?? null
    entries = await (limit === null ? readdir(dir) : readdir(dir, false, limit))
    const budget = ctx.budget
    if (budget !== undefined) entries = entries.filter(() => budget.spend(dir.virtual))
  } catch (err) {
    // A directory whose own `.` and `..` did not resolve is not one the
    // namespace can owe children to, and one the session may not open is
    // refused whole: the names the namespace owes it (a link in it, a mount
    // below it) are as much its listing as the backend's are.
    if (
      !isWalkError(err) ||
      isDotWalkError(err) ||
      isEacces(err) ||
      (childMounts?.(dir.virtual) ?? []).length === 0
    )
      throw err
    // No backend serves it, but the namespace owes it children (a
    // nested mount, a link's ancestors), so the dispatcher lists it as a
    // directory and ls must agree: the merge below renders those rows
    // from an empty backend listing.
    entries = []
    structureOnly = true
  }
  const entryStat: StatFn = (p: PathSpec) => followedStat(stat, ctx.deref ? links : null, p)
  const prefix = mountPrefixOf(dir.virtual, dir.vfsPath)
  const stats: FileStat[] = []
  for (const entry of entries) {
    if (ctx.ignore.length > 0) {
      const trimmed = rstripSlash(entry)
      if (ignored(ctx.ignore, trimmed.slice(trimmed.lastIndexOf('/') + 1))) continue
    }
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
        message: `ls: cannot access '${spell(rstripSlash(entry))}': ${strerrorOf(err)}`,
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
    if (seen.has(name) || ignored(ctx.ignore, name)) continue
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
  stat: StatFn,
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
  readdir: ReaddirFn<[path: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  path: PathSpec,
  ctx: WalkOpts,
  warnings: LsWarning[],
  commandLineArg: boolean,
  spell: ((virtual: string) => string) | null = null,
): Promise<Operand> {
  const spelled = spell ?? ((virtual: string) => respellOne(virtual, path.virtual, path.rawPath))
  const links = ctx.links
  const ownStat: StatFn = (p: PathSpec) => followedStat(stat, ctx.deref ? links : null, p)
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
    const listed = await statEntries(readdir, stat, path, ctx, warnings, spelled)
    stats = listed.stats
    structureOnly = listed.structureOnly
  } catch (err) {
    if (!isWalkError(err)) throw err
    // The operand did not resolve, so neither the path it simplifies to
    // nor a link standing there answers for it. A command-line link whose
    // stat loops is the exception: GNU lstats it then and lists the link
    // itself, unless -L or -H asked for the target (coreutils 9.7).
    const walkRefused = isDotWalkError(err)
    const looped = walkRefused && (err as { code?: string }).code === 'ELOOP'
    let found: FileStat | null = null
    let refused: unknown = null
    if (!walkRefused) {
      try {
        found = await operandStat(ownStat, path)
      } catch (statErr) {
        if (!isWalkError(statErr)) throw statErr
        refused = statErr
      }
    }
    if (found !== null && found.type !== FileType.DIRECTORY) {
      return { path, row: asOperand(found, path), groups: [] }
    }
    const link = looped && commandLineArg && !ctx.followArgs ? linkRow(path, links) : null
    if (link !== null) return { path, row: link, groups: [] }
    // GNU 9.7 stats an operand before it opens one: a stat that fails is what
    // it names, and a directory it may not read is worded apart, the entry
    // being there.
    const verb = found !== null && isEacces(err) ? 'cannot open directory' : 'cannot access'
    const refusal: LsWarning = {
      message: `ls: ${verb} '${path.rawPath}': ${errText(refused ?? err)}`,
      serious: commandLineArg,
    }
    if (commandLineArg && verb === 'cannot access') {
      warnings.push(refusal)
      return { path, row: null, groups: [] }
    }
    // A directory that is there but will not open is reported where its
    // listing would have printed (GNU 9.7).
    return { path, row: null, groups: [], notes: [[0, refusal]] }
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
  const entries = await sortStats(
    stats,
    ctx.sortBy,
    ctx.reverse,
    ctx.timeKind,
    ctx.groupDirsFirst,
    ctx.quote,
  )
  return { path, row: null, groups: [[path, entries]] }
}

// Sort row for one operand, named with the operand's own spelling.
async function operandKey(operand: Operand, sortBy: LsSortBy, stat: StatFn): Promise<FileStat> {
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
  stat: StatFn,
  timeKind: LsTimeKind,
  quote: Quote | null,
): Promise<Operand[]> {
  const keyed: { key: FileStat; operand: Operand }[] = []
  for (const operand of operands) {
    keyed.push({ key: await operandKey(operand, sortBy, stat), operand })
  }
  if (sortBy === 'none') return keyed.map((k) => k.operand)
  if (sortBy === 'version') {
    const order = await sortByVersion(keyed.map((k) => k.key.name))
    const ordered = order.flatMap((i) => keyed[i]?.operand ?? [])
    return reverse ? ordered.reverse() : ordered
  }
  const sign = reverse ? -1 : 1
  const widths = new Map(
    sortBy === 'width'
      ? keyed.map(
          ({ key }) => [key.name, textWidth(quote === null ? key.name : quote(key.name))] as const,
        )
      : [],
  )
  keyed.sort((a, b) => sign * compareStats(a.key, b.key, sortBy, timeKind, widths))
  return keyed.map((k) => k.operand)
}

/** The ls flag bag, parsed once. */
export interface LsFlags {
  readonly layout: LsFormat
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
  // The --quoting-style word, and -q.
  readonly quoting: string
  readonly hideControl: boolean
  readonly hyperlink: boolean
  // The line width, null for no limit, and the tab stops, 0 for spaces only.
  readonly width: number | null
  readonly tabsize: number
  // The patterns of -I, -B and --hide.
  readonly ignore: readonly string[]
  // An environment value ls ignored, each in its words.
  readonly notices: readonly string[]
}

// The three spellings of a command-line link policy; the last one wins.
const FOLLOWS: Readonly<Record<LsLinkMode, Follow>> = {
  all: Follow.LAST,
  directory: Follow.DIRECTORY,
  none: Follow.NONE,
}

const DEREF_DESTS = [
  'dereference',
  'dereference_command_line',
  'dereference_command_line_symlink_to_dir',
] as const
// The four spellings of an indicator style; the last one typed wins.
const INDICATOR_DESTS = ['classify', 'file_type', 'p', 'indicator_style'] as const
// The spellings of a format; the last one typed wins, but -1 leaves a long
// format long.
const FORMAT_DESTS = [
  'args_l',
  'g',
  'o',
  'numeric_uid_gid',
  'full_time',
  'args_1',
  'C',
  'x',
  'm',
  'format',
] as const
// What mirage-rs reads: every option that carries a word, a size or a style,
// in the order typed.
const SCANNED = [
  'sort',
  't',
  'S',
  'X',
  'v',
  'U',
  'time',
  'c',
  'u',
  'hyperlink',
  'color',
  'classify',
  'indicator_style',
  'p',
  'file_type',
  'block_size',
  'human_readable',
  'si',
  'time_style',
  'f',
  ...FORMAT_DESTS,
  'quoting_style',
  'escape',
  'literal',
  'quote_name',
  'hide_control_chars',
  'show_control_chars',
  'width',
  'tabsize',
] as const
// GNU reads a bare --classify, --hyperlink or --color as `always`.
const BARE_ALWAYS: ReadonlySet<string> = new Set(['classify', 'hyperlink', 'color'])
// The environment ls reads where no option gives the value, and the name
// the scan reads each one under.
const ENVIRONMENT = [
  ['QUOTING_STYLE', 'quoting_env'],
  ['COLUMNS', 'columns_env'],
] as const
// The quoting styles that leave some names bare, under which a bare name in
// columns or a long listing takes a space to line up with quoted ones.
const ALIGNED_STYLES: ReadonlySet<string> = new Set(['shell', 'shell-escape', 'c-maybe'])
const ALIGNED_LAYOUTS: ReadonlySet<LsFormat> = new Set(['verbose', 'vertical', 'horizontal'])
// What -B leaves out.
const BACKUPS = ['*~', '.*~']

/** What mirage-rs read out of ls's typed options: the last sort spelling (null
 * when the line typed none), the timestamp shown and sorted by, the mark
 * appended to a name, whether `--hyperlink` asked for OSC 8 links,
 * `--block-size` (null for bytes or when `-h` came after it), the time
 * style (`locale`, `full-iso`, `long-iso`, `iso` or `+FORMAT`), the format,
 * the quoting style and `-q`, the line width (null for no limit), the tab
 * stops, and each environment value ls ignored, in its words. */
interface LsValues {
  readonly sortBy: LsSortBy | null
  readonly timeKind: LsTimeKind
  readonly indicator: LsIndicator
  readonly hyperlink: boolean
  readonly blockSize: BlockSize | null
  readonly timeStyle: string
  readonly layout: LsFormat
  readonly quoting: string
  readonly hideControl: boolean
  readonly width: number | null
  readonly tabsize: number
  readonly warnings: readonly string[]
}

function oneOf<T extends string>(
  words: readonly T[],
  value: JsonValue | undefined,
  what: string,
): T {
  const found = words.find((word) => word === value)
  if (found === undefined) {
    throw new Error(`ls: mirage-rs read ${what} as ${JSON.stringify(value)}`)
  }
  return found
}

// The typed options as the scan reads them: a switch empty, except the bare
// spelling of an option that takes WHEN, which is the word GNU reads it as and
// stays apart from an explicit empty value.
function tape(fl: FlagView, names: readonly string[]): [string, string][] {
  return fl
    .occurrences(...names)
    .filter(([, value]) => value !== false)
    .map(([dest, value]): [string, string] => [
      dest,
      value === true && BARE_ALWAYS.has(dest) ? 'always' : typeof value === 'string' ? value : '',
    ])
}

/**
 * ls's option values, read by mirage-rs in one pass over the line; `names`
 * picks which options to read, the others keeping their defaults, and the
 * environment's `QUOTING_STYLE` and `COLUMNS` stand in for an option the
 * line did not type. Throws UsageError for the first value ls refuses, in
 * its words and with its exit status. Mirrors Python's `scan_values`.
 */
function scanValues(
  fl: FlagView,
  names: readonly string[] = SCANNED,
  env?: Readonly<Record<string, string>>,
): LsValues {
  const typed = tape(fl, names)
  for (const [variable, dest] of ENVIRONMENT) {
    const value = env?.[variable]
    if (value !== undefined) typed.push([dest, value])
  }
  const values = scanned('ls', typed)
  const { sort, hyperlink, quoting, width, tabsize, warnings } = values
  const style = values.time_style
  const hideControl = values.hide_control
  if (
    typeof hyperlink !== 'boolean' ||
    typeof style !== 'string' ||
    typeof quoting !== 'string' ||
    typeof hideControl !== 'boolean' ||
    (width !== null && typeof width !== 'number') ||
    typeof tabsize !== 'number' ||
    !Array.isArray(warnings) ||
    !warnings.every((w) => typeof w === 'string')
  ) {
    throw new Error(`ls: mirage-rs read the options as ${JSON.stringify(values)}`)
  }
  return {
    sortBy:
      sort === null
        ? null
        : oneOf<LsSortBy>(
            ['name', 'time', 'size', 'version', 'extension', 'width', 'none'],
            sort,
            '--sort',
          ),
    timeKind: oneOf<LsTimeKind>(['mtime', 'atime', 'ctime', 'birth'], values.time, '--time'),
    indicator: oneOf<LsIndicator>(
      ['none', 'slash', 'file-type', 'classify'],
      values.indicator,
      'the indicator',
    ),
    hyperlink,
    blockSize: blockSizeOf(values.block_size),
    timeStyle: textView(style),
    layout: oneOf<LsFormat>(
      ['verbose', 'commas', 'horizontal', 'vertical', 'single-column'],
      values.format,
      '--format',
    ),
    quoting,
    hideControl,
    width,
    tabsize,
    warnings: warnings.map((w) => textView(w)),
  }
}

/**
 * Which command-line links ls resolves before it lists them. It is settled
 * once: the last of -L, -H and --dereference-command-line-symlink-to-dir
 * wins, and with none of them -d, a long format or the classify style resolve
 * no link while anything else resolves one that leads to a directory
 * (coreutils 9.7). A value the command refuses leaves the line neither long
 * nor classified, since that line fails before it lists anything. `values`
 * is a scan of the whole line already read; without it the format and
 * indicator options are read here. Mirrors Python's link_mode.
 */
export function linkMode(fl: FlagView, values?: LsValues): LsLinkMode {
  const typed = fl.typedOrder(...DEREF_DESTS)
  const last = typed.at(-1)
  if (last !== undefined) {
    return last === 'dereference_command_line_symlink_to_dir' ? 'directory' : 'all'
  }
  let long = false
  let classify = false
  try {
    const read = values ?? scanValues(fl, [...INDICATOR_DESTS, ...FORMAT_DESTS])
    long = read.layout === 'verbose'
    classify = read.indicator === 'classify'
  } catch (err) {
    // The command refuses this line itself, before it lists anything.
    if (!(err instanceof UsageError)) throw err
  }
  return fl.asBool('directory') || long || classify ? 'none' : 'directory'
}

/**
 * An ls line resolves the command-line links `linkMode` says, and walks, and
 * reads, below its operands under `-R`. Mirrors Python's `facts`.
 */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  const recursive = fl.asBool('recursive')
  return new LineFacts({
    follows: FOLLOWS[linkMode(fl)],
    walks: recursive,
    readsSubtree: recursive,
  })
}

// Parse the ls flag bag once into a frozen struct. The rules that are easy to
// get wrong: -g, -o, -n and --full-time imply the long format, and -1 never
// undoes it in either order; -n prints the same columns as -l, because a
// mirage owner is already the id (an agent, a profile) and never a name
// looked up from one; -c or -u with no sort sorts by that time unless the
// format is long; -f lists every entry unsorted, and the last of -a, -A and
// -f says which dot entries show; --hide leaves names out only where none of
// those three asked for them. The words, sizes and styles (the last sort,
// time, format, quoting and indicator spelling, the later of -h, --si and
// --block-size) are mirage-rs's, read in one pass. `env` is the environment,
// for QUOTING_STYLE and COLUMNS. Throws UsageError for a value ls refuses,
// with its exit status for that option. Mirrors Python's parse_flags.
export function parseFlags(fl: FlagView, env?: Readonly<Record<string, string>>): LsFlags {
  const values = scanValues(fl, SCANNED, env)
  const long = values.layout === 'verbose'
  const sortBy: LsSortBy =
    values.sortBy === null && values.timeKind !== 'mtime' && !long
      ? 'time'
      : (values.sortBy ?? 'name')
  const columns: LsColumns = Object.freeze({
    owner: !fl.asBool('g'),
    group: !(fl.asBool('o') || fl.asBool('no_group')),
    inode: fl.asBool('inode'),
    blocks: fl.asBool('size'),
    context: fl.asBool('context'),
    timeKind: values.timeKind,
    timeStyle: values.timeStyle,
    blockSize: values.blockSize,
  })
  const shown = fl.typedOrder('all', 'almost_all', 'f').at(-1)
  const all = shown !== undefined
  const ignore = [...fl.asList('ignore')]
  if (fl.asBool('ignore_backups')) ignore.push(...BACKUPS)
  if (!all) ignore.push(...fl.asList('hide'))
  return Object.freeze({
    layout: values.layout,
    all,
    showDotEntries: all && shown !== 'almost_all',
    human: fl.asBool('human_readable'),
    reverse: fl.asBool('reverse'),
    indicator: values.indicator,
    recursive: fl.asBool('recursive'),
    listDir: fl.asBool('directory'),
    // -L alone dereferences what a listing finds; -H and its sibling stop at
    // the command line, and the last of the three wins.
    deref: fl.typedOrder(...DEREF_DESTS).at(-1) === 'dereference',
    followArgs: linkMode(fl, values) === 'all',
    sortBy,
    timeKind: values.timeKind,
    groupDirsFirst: fl.asBool('group_directories_first'),
    columns,
    quoting: values.quoting,
    hideControl: values.hideControl,
    hyperlink: values.hyperlink,
    width: values.width,
    tabsize: values.tabsize,
    ignore: Object.freeze(ignore),
    notices: values.warnings,
  })
}

// Whether GNU's ls would stat a listed entry to print this listing, which
// is when a failed stat reaches stderr: the long format, a time or size
// sort, -i, -s, -Z and --hyperlink read the stat, and -R, -F and
// --group-directories-first read the type, which a mirage listing never
// carries, as a readdir without d_type does not. A plain listing prints the
// names readdir gave and nothing else.
function statNeeded(flags: LsFlags): boolean {
  return (
    flags.layout === 'verbose' ||
    flags.sortBy === 'time' ||
    flags.sortBy === 'size' ||
    flags.columns.inode ||
    flags.columns.blocks ||
    flags.columns.context ||
    flags.hyperlink ||
    flags.recursive ||
    flags.indicator !== 'none' ||
    flags.groupDirsFirst
  )
}

// GNU looks at every operand before it lists one, so what it reports comes
// before what it lists (`ls d missing 2>&1`), all but a directory it does not
// list (one that will not open, one -L already listed), reported where that
// listing would have printed: `placed` holds each such warning with the index
// in `lines` it is written before, in order.
// Mirrors Python's _finish.
function finish(
  lines: string[],
  warnings: readonly LsWarning[],
  notices: readonly string[],
): CommandFnResult {
  const out = formatRecords(lines)
  const exitCode = exitStatusFor(warnings)
  const leading = [...notices, ...warnings.map((w) => w.message)]
  if (leading.length === 0) return [out, new IOResult({ exitCode })]
  const stderr = formatRecords(leading)
  if (out.byteLength === 0) return [out, new IOResult({ stderr, exitCode })]
  const io = new IOResult({ exitCode })
  return [atOffsets(out, [[0, stderr]], io), io]
}

// `statPath` stats a mount root or dot entry across mounts; the cross-mount relay passes none.
export async function lsGeneric(
  paths: PathSpec[],
  ctx: Context,
  readdir: ReaddirFn<[path: PathSpec, nofollow?: boolean, limit?: number]>,
  stat: StatFn,
  statPath: StatPath | null = vfsStatPath(ctx.vfs) ?? null,
  flags: LsFlags = parseFlags(new FlagView(ctx.flags, specOf('ls')), ctx.env),
): Promise<CommandFnResult> {
  const targets: PathSpec[] =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: ctx.cwd.virtual,
            directory: ctx.cwd.virtual,
            resolved: false,
            vfsPath: ctx.cwd.vfsPath,
          }),
        ]
  const {
    layout,
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
  const long = layout === 'verbose'
  const { quoting, hideControl, notices } = flags
  const quote: Quote | null =
    quoting === 'literal' && !hideControl ? null : (name) => quoteName(name, quoting, hideControl)
  const render: RenderOpts = {
    quote,
    align: ALIGNED_STYLES.has(quoting) && ALIGNED_LAYOUTS.has(layout),
    layout,
    long,
    width: flags.width,
    tabsize: flags.tabsize,
    human,
    indicator,
    identity,
    columns: flags.columns,
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
        ? await sortStats(
            collected.map((c) => c.row),
            sortBy,
            reverse,
            timeKind,
            groupDirsFirst,
            quote,
          )
        : collected.map((c) => c.row)
    const rowPaths = rows.map((r) => byRow.get(r) ?? '')
    await renderGroup(
      rows,
      render,
      lines,
      flags.hyperlink ? rowPaths : null,
      await linkTargets(rows, rowPaths, links, render),
    )
    return finish(lines, warnings, notices)
  }

  const walkOpts: WalkOpts = {
    quote,
    ignore: flags.ignore,
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
  const budgets = new Map<Operand, WalkBudget>()
  for (const p of targets) {
    const budget = recursive ? new WalkBudget(p, walkOpts.mounts) : undefined
    const opts = budget === undefined ? walkOpts : { ...walkOpts, budget }
    const operand = await probeOperand(readdir, stat, p, opts, warnings, true)
    if (budget !== undefined) budgets.set(operand, budget)
    probed.push(operand)
  }
  const operands =
    probed.length > 1 ? await sortOperands(probed, sortBy, reverse, stat, timeKind, quote) : probed

  type Walked = [PathSpec, FileStat[]] | LsWarning

  // -R lists each directory below an operand as the walk reaches it, in
  // pre-order, so a reader that stops early stops the walk; what the walk
  // reports goes out where the walk meets it.
  async function* below(
    path: PathSpec,
    entries: readonly FileStat[],
    chain: readonly string[],
    spell: (virtual: string) => string,
    opts: WalkOpts,
  ): AsyncGenerator<Walked> {
    const real = deref && links !== null ? (virtual: string) => links.resolve(virtual) : null
    const open = real !== null && chain.length === 0 ? [real(path.virtual)] : chain
    for (const s of entries) {
      if (s.type !== FileType.DIRECTORY) continue
      const childPath = `${rstripSlash(path.virtual)}/${s.name}`
      if (walkOpts.mounts?.isRoot(childPath) ?? false) {
        // A nested mount's root. Its row belongs here, but its listing is
        // another backend's, which this walk cannot read: the cross-mount
        // fan-out renders that group.
        continue
      }
      if (opts.budget !== undefined && !opts.budget.opens(childPath)) continue
      let under = open
      if (real !== null) {
        // Under -L a directory is the one it resolves to, and one open above
        // this one is never listed again (exit 2).
        const here = real(childPath)
        if (open.includes(here)) {
          yield {
            message: `ls: ${spell(childPath)}: not listing already-listed directory`,
            serious: true,
          }
          continue
        }
        under = [...open, here]
      }
      const found: LsWarning[] = []
      const child = await probeOperand(
        readdir,
        stat,
        childSpec(childPath, mountPrefixOf(path.virtual, path.vfsPath)),
        opts,
        found,
        false,
        spell,
      )
      yield* found
      for (const [, note] of child.notes ?? []) yield note
      for (const [dirSpec, listed] of child.groups) {
        yield [dirSpec, listed]
        yield* below(dirSpec, listed, under, spell, opts)
      }
    }
  }

  const finished = new Set<Operand>()

  async function* groups(operand: Operand): AsyncGenerator<Walked> {
    const spell = (virtual: string): string =>
      respellOne(virtual, operand.path.virtual, operand.path.rawPath)
    const budget = budgets.get(operand)
    const opts = budget === undefined ? walkOpts : { ...walkOpts, budget }
    for (const [, note] of operand.notes ?? []) yield note
    for (const [dirSpec, entries] of operand.groups) {
      yield [dirSpec, entries]
      if (recursive) yield* below(dirSpec, entries, [], spell, opts)
    }
    for (const line of budget?.stopped ?? []) yield { message: `ls: ${line}`, serious: false }
    finished.add(operand)
  }

  async function withDots(
    dirSpec: PathSpec,
    entries: FileStat[],
    found: LsWarning[],
  ): Promise<FileStat[]> {
    const dots: FileStat[] = []
    const prefix = mountPrefixOf(dirSpec.virtual, dirSpec.vfsPath)
    for (const name of ['.', '..']) {
      if (ignored(flags.ignore, name)) continue
      const target = posixNormpath(`${dirSpec.virtual}/${name}`)
      let row = new FileStat({ name, type: FileType.DIRECTORY })
      // Only the namespace can stat a parent outside this mount.
      // Without `statPath`, keep the synthetic directory row.
      if (statNeeded(flags) && (statPath !== null || underPath(target, prefix))) {
        try {
          const stated =
            statPath !== null ? await statPath(target) : await stat(childSpec(target, prefix))
          if (stated !== null) row = stated.with({ name })
        } catch (err) {
          if (!isWalkError(err)) throw err
          row = statFailedRow(name)
          found.push({ message: `ls: cannot access '${name}': ${errText(err)}`, serious: false })
        }
      }
      dots.push(row)
    }
    return sortStats([...dots, ...entries], sortBy, reverse, timeKind, groupDirsFirst, quote)
  }

  // The listing a block at a time, each warning the walk meets between the
  // blocks it falls between.
  async function* pieces(): AsyncGenerator<Uint8Array | LsWarning> {
    // ls names every listed directory once there is more than one operand
    // (or under -R); a lone directory operand is listed bare.
    const headed = recursive || targets.length > 1
    const rowed = operands.filter((o) => o.row !== null)
    const rows = rowed.flatMap((o) => (o.row !== null ? [o.row] : []))
    const rowPaths = rowed.map((o) => o.path.virtual)
    await renderGroup(
      rows,
      render,
      lines,
      flags.hyperlink ? rowPaths : null,
      await linkTargets(rows, rowPaths, links, render),
    )
    let printed = rows.length > 0
    if (lines.length > 0) yield formatRecords(lines.splice(0))
    for (const operand of operands) {
      for await (const item of groups(operand)) {
        if (!Array.isArray(item)) {
          yield item
          continue
        }
        const [dirSpec, group] = item
        let entries = group
        if (flags.showDotEntries) {
          const found: LsWarning[] = []
          entries = await withDots(dirSpec, group, found)
          yield* found
        }
        if (headed) {
          if (printed) lines.push('')
          const header = respellOne(dirSpec.virtual, operand.path.virtual, operand.path.rawPath)
          lines.push(`${quote === null ? header : quote(header)}:`)
        }
        // ls prints allocated blocks; VFS has no allocation metadata.
        if (long || flags.columns.blocks) lines.push(entries.length > 0 ? 'total ?' : 'total 0')
        const entryPaths = entries.map((e) => `${rstripSlash(dirSpec.virtual)}/${e.name}`)
        await renderGroup(
          entries,
          render,
          lines,
          flags.hyperlink ? entryPaths : null,
          await linkTargets(entries, entryPaths, links, render),
        )
        printed = true
        if (lines.length > 0) yield formatRecords(lines.splice(0))
      }
    }
  }

  // GNU looks at every operand before it lists one, so what that found goes
  // first; the rest goes where the walk met it.
  const reported = [...warnings]
  const pending = [...notices, ...warnings.map((w) => w.message)]
  if (recursive) {
    const io = new IOResult()
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      try {
        for await (const piece of pieces()) {
          if (!(piece instanceof Uint8Array)) {
            reported.push(piece)
            pending.push(piece.message)
            continue
          }
          if (pending.length > 0) await say(io, formatRecords(pending.splice(0)))
          yield piece
        }
      } finally {
        // A reader that stops early still gets what was found for the
        // operands it never finished, after what it read.
        const seen = new Set(reported)
        for (const operand of operands) {
          if (finished.has(operand)) continue
          const stopped = budgets.get(operand)?.stopped ?? []
          for (const warning of [
            ...(operand.notes ?? []).map(([, note]) => note),
            ...stopped.map((line) => ({ message: `ls: ${line}`, serious: false })),
          ]) {
            if (seen.has(warning)) continue
            seen.add(warning)
            reported.push(warning)
            pending.push(warning.message)
          }
        }
        if (pending.length > 0) await say(io, formatRecords(pending.splice(0)))
        io.exitCode = exitStatusFor(reported)
      }
    }
    return [stream(), io]
  }
  const body: Uint8Array[] = []
  const notes: [number, Uint8Array][] = []
  let offset = 0
  for await (const piece of pieces()) {
    if (!(piece instanceof Uint8Array)) {
      reported.push(piece)
      pending.push(piece.message)
      continue
    }
    if (pending.length > 0) notes.push([offset, formatRecords(pending.splice(0))])
    body.push(piece)
    offset += piece.byteLength
  }
  const out = concat(body)
  const exitCode = exitStatusFor(reported)
  if (out.byteLength === 0) {
    return [
      out,
      new IOResult(
        pending.length > 0 ? { stderr: formatRecords(pending), exitCode } : { exitCode },
      ),
    ]
  }
  if (pending.length > 0) notes.push([offset, formatRecords(pending)])
  const io = new IOResult({ exitCode })
  return [atOffsets(out, notes, io), io]
}
