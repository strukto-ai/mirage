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
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec, type LsSortBy, type LsTimeKind } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import type { ChildMounts, LinkView, MountView, StatPath } from '../../../ops/types.ts'
import {
  LS_TIME_STYLES,
  type LsColumns,
  formatLsLong,
  lsName,
  lsPrefix,
  parseBlockSize,
  timeOf,
  type BlockSizeRefusal,
} from '../utils/formatting.ts'
import { UsageError } from '../../errors.ts'
import { argmatchError, argmatchLine, usageHint } from '../../spec/usage.ts'
import { type ArgmatchKind, argmatch } from '../../spec/argmatch.ts'
import { identityOf, type Identity } from '../utils/identity.ts'
import { gnuStrerror, isEacces, isWalkError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { CycleError, respellOne } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { charWidth } from '../../../utils/width.ts'

type Readdir = (p: PathSpec) => Promise<string[]>
type Stat = (p: PathSpec) => Promise<FileStat>
type SortBy = LsSortBy

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
  all: boolean
  sortBy: SortBy
  reverse: boolean
  // Which timestamp -t compares, and --group-directories-first.
  timeKind: LsTimeKind
  groupDirsFirst: boolean
  recursive: boolean
  // Links have no backend inode, so readdir never names them. Merging
  // them in means every caller (plain, -R, -F, -l, sorting) sees them
  // without knowing they are special.
  links: LinkView | null
  // -L reports the target's stat under the link's own name. A
  // dereferenced directory link then carries FileType.DIRECTORY, which
  // is what makes -R descend it.
  deref: boolean
  // Session-filtered child-mount names: the other half of namespace
  // structure beside links, merged as directory rows in every listing.
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
  return (
    gnuStrerror((err as { code?: string }).code) ??
    (err instanceof Error ? err.message : String(err))
  )
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

// GNU -F suffixes: a directory gets "/", a symlink "@". The link mark
// rides the row's type, so it needs no separate lookup.
const CLASSIFY_SUFFIX: Partial<Record<FileType, string>> = {
  [FileType.DIRECTORY]: '/',
  [FileType.SYMLINK]: '@',
}

// Short rows: the name, -F's mark, and -i/-Z's lead.
function formatShort(s: FileStat, classify: boolean, columns: LsColumns, name?: string): string {
  const suffix = (classify ? CLASSIFY_SUFFIX[s.type] : undefined) ?? ''
  return `${lsPrefix(columns)}${name ?? s.name}${suffix}`
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
    for (const byte of new TextEncoder().encode(ch)) out += `%${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

interface RenderOpts {
  long: boolean
  human: boolean
  classify: boolean
  identity: Identity
  columns: LsColumns
}

function appendListing(
  stats: readonly FileStat[],
  render: RenderOpts,
  lines: string[],
  hrefs: readonly string[] | null = null,
): void {
  const names =
    hrefs === null
      ? null
      : stats.map((s, i) => {
          const linked = hyperlinked(s.name, hrefs[i] ?? '')
          return render.long ? lsName(s.with({ name: linked })) : linked
        })
  if (render.long) {
    const opts = {
      human: render.human,
      identity: render.identity,
      columns: render.columns,
      ...(names !== null ? { names } : {}),
    }
    for (const line of formatLsLong(stats, opts)) lines.push(line)
    return
  }
  stats.forEach((s, i) => lines.push(formatShort(s, render.classify, render.columns, names?.[i])))
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

const NAME_BYTES = new TextEncoder()

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
  const ab = NAME_BYTES.encode(a)
  const bb = NAME_BYTES.encode(b)
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

function primaryValue(entry: FileStat, sortBy: SortBy, timeKind: LsTimeKind): string | number {
  return sortBy === 'time' ? (timeOf(entry, timeKind) ?? '') : (entry.size ?? 0)
}

// GNU's -t/-S comparators fall back to the name when the timestamps or sizes
// tie, so the order is total. `-r` negates the whole comparison, tie-break
// included, which is why callers fold the sign into this comparator instead of
// reversing the finished array. -X and --sort=width are stable sorts over
// the name order too; -v is gnulib's version order.
function compareStats(a: FileStat, b: FileStat, sortBy: SortBy, timeKind: LsTimeKind): number {
  if (sortBy === 'version') return filevercmp(a.name, b.name)
  if (sortBy === 'extension') {
    const byExt = compareCodePoints(extensionOf(a.name), extensionOf(b.name))
    if (byExt !== 0) return byExt
  } else if (sortBy === 'width') {
    const byWidth = nameWidth(a.name) - nameWidth(b.name)
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
  sortBy: SortBy,
  reverse: boolean,
  timeKind: LsTimeKind = 'mtime',
  groupDirsFirst = false,
): FileStat[] {
  let ordered: FileStat[]
  if (sortBy === 'none') {
    ordered = [...stats]
  } else {
    const sign = reverse ? -1 : 1
    ordered = [...stats].sort((a, b) => sign * compareStats(a, b, sortBy, timeKind))
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
async function fileEntry(stat: Stat, path: PathSpec): Promise<FileStat | null> {
  try {
    const s = await stat(path)
    return s.type !== FileType.DIRECTORY ? asOperand(s, path) : null
  } catch (err) {
    if (!isWalkError(err)) throw err
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

// An entry that cannot be stat'd is skipped with its own diagnostic rather
// than failing the whole directory: GNU keeps listing the siblings and exits
// 1. Mirrors the per-entry tolerance of Python ls `_stat_entries`.
async function listDir(
  readdir: Readdir,
  stat: Stat,
  dir: PathSpec,
  all: boolean,
  warnings: LsWarning[],
  links: LinkView | null,
  deref: boolean,
  stat2: Stat,
  childMounts: ChildMounts | null,
  statPath: StatPath | null,
): Promise<{ stats: FileStat[]; structureOnly: boolean }> {
  let entries: string[]
  let structureOnly = false
  try {
    entries = await readdir(dir)
  } catch (err) {
    if (!isWalkError(err) || (childMounts?.(dir.virtual) ?? []).length === 0) throw err
    // No backend serves it, but the namespace owes it children (a
    // nested mount, a link's ancestors), so the door lists it as a
    // directory and ls must agree: the merge below renders those rows
    // from an empty backend listing.
    entries = []
    structureOnly = true
  }
  const prefix = mountPrefixOf(dir.virtual, dir.vfsPath)
  const settled = await Promise.allSettled(entries.map((p) => stat(childSpec(p, prefix))))
  const stats: FileStat[] = []
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]
    const entry = entries[i]
    if (outcome === undefined || entry === undefined) continue
    if (outcome.status === 'rejected') {
      if (!isWalkError(outcome.reason)) throw outcome.reason
      // An entry below an operand is never a command-line arg.
      warnings.push({
        message: `ls: cannot access '${entry}': ${errText(outcome.reason)}`,
        serious: false,
      })
      continue
    }
    stats.push(outcome.value)
  }
  const seen = new Set(stats.map((s) => s.name))
  for (const link of links?.children(dir.virtual) ?? []) {
    if (seen.has(link.name)) continue
    seen.add(link.name)
    const resolved = deref && links !== null ? await derefEntry(dir, link, links, stat2) : null
    stats.push(resolved ?? link)
  }
  for (const name of childMounts?.(dir.virtual) ?? []) {
    if (seen.has(name)) continue
    seen.add(name)
    stats.push(await mountRow(dir, name, statPath))
  }
  return {
    stats: all ? stats : stats.filter((s) => !s.name.startsWith('.')),
    structureOnly,
  }
}

// The row for an operand that is itself a symlink, else null.
//
// A link has no backend inode, so readdir and stat both fail on one;
// without this a link operand reads as a missing file, and a dangling
// link fails the whole listing (GNU prints its row and exits 0). Named
// with the operand's own spelling, like every other ls row.
// The target's stat for a link child under -L, or null if unreadable.
// GNU `ls -L` reports the referenced file while keeping the link's own
// name, so a dangling link falls back to the link row.
async function derefEntry(
  directory: PathSpec,
  link: FileStat,
  links: LinkView,
  stat: Stat,
): Promise<FileStat | null> {
  const child = `${rstripSlash(directory.virtual)}/${link.name}`
  let target: string
  try {
    target = links.resolve(child)
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    return null
  }
  const spec = childSpec(target, mountPrefixOf(directory.virtual, directory.vfsPath))
  try {
    const s = await stat(spec)
    return s.with({ name: link.name })
  } catch (err) {
    if (!isWalkError(err)) throw err
    return null
  }
}

// Renaming a link row copies every field, not a hand-picked few: a link
// carries real ownership (chown -h writes it), and listing the fields by
// hand silently drops whatever the node grows next.
function linkRow(path: PathSpec, links: LinkView | null): FileStat | null {
  const row = links?.statAt(path.virtual) ?? null
  if (row === null) return null
  return row.with({ name: path.rawPath })
}

// List one operand and report whether it turned out to be a directory.
async function probeOperand(
  readdir: Readdir,
  stat: Stat,
  path: PathSpec,
  opts: WalkOpts,
  warnings: LsWarning[],
  commandLineArg: boolean,
): Promise<Operand> {
  let stats: FileStat[]
  let structureOnly = false
  try {
    const listed = await listDir(
      readdir,
      stat,
      path,
      opts.all,
      warnings,
      opts.links,
      opts.deref,
      stat,
      opts.childMounts,
      opts.statPath,
    )
    stats = listed.stats
    structureOnly = listed.structureOnly
  } catch (err) {
    if (!isWalkError(err)) throw err
    const row = await fileEntry(stat, path)
    if (row !== null) return { path, row, groups: [] }
    const link = linkRow(path, opts.links)
    if (link !== null) return { path, row: link, groups: [] }
    // GNU words a directory it may not read differently from one it
    // cannot stat: the entry is there, opening it is what failed.
    const verb = isEacces(err) ? 'cannot open directory' : 'cannot access'
    warnings.push({
      message: `ls: ${verb} '${path.rawPath}': ${errText(err)}`,
      serious: commandLineArg,
    })
    return { path, row: null, groups: [] }
  }
  if (stats.length === 0 && !structureOnly) {
    const row = await fileEntry(stat, path)
    if (row !== null) return { path, row, groups: [] }
    // Backends without real directories answer readdir on a link with
    // an empty list instead of throwing, so the link operand has to be
    // caught here too or it renders as an empty directory.
    const link = linkRow(path, opts.links)
    if (link !== null) return { path, row: link, groups: [] }
  }
  const entries = sortStats(stats, opts.sortBy, opts.reverse, opts.timeKind, opts.groupDirsFirst)
  const groups: [PathSpec, FileStat[]][] = [[path, entries]]
  if (opts.recursive) {
    for (const s of entries) {
      if (s.type !== FileType.DIRECTORY) continue
      const childPath = `${rstripSlash(path.virtual)}/${s.name}`
      if (opts.mounts?.isRoot(childPath) ?? false) {
        // A nested mount's root. Its row belongs here, but its listing
        // is another backend's, which this walk cannot read: the
        // cross-mount fan-out renders that group.
        continue
      }
      const child = await probeOperand(
        readdir,
        stat,
        childSpec(childPath, mountPrefixOf(path.virtual, path.vfsPath)),
        opts,
        warnings,
        false,
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
async function operandKey(operand: Operand, sortBy: SortBy, stat: Stat): Promise<FileStat> {
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
  sortBy: SortBy,
  reverse: boolean,
  stat: Stat,
  timeKind: LsTimeKind,
): Promise<Operand[]> {
  const keyed: { key: FileStat; operand: Operand }[] = []
  for (const operand of operands) {
    keyed.push({ key: await operandKey(operand, sortBy, stat), operand })
  }
  if (sortBy === 'none') return keyed.map((k) => k.operand)
  const sign = reverse ? -1 : 1
  keyed.sort((a, b) => sign * compareStats(a.key, b.key, sortBy, timeKind))
  return keyed.map((k) => k.operand)
}

/** The ls flag bag, parsed once. */
export interface LsFlags {
  readonly long: boolean
  readonly all: boolean
  readonly human: boolean
  readonly reverse: boolean
  readonly classify: boolean
  readonly recursive: boolean
  readonly listDir: boolean
  readonly deref: boolean
  readonly sortBy: SortBy
  readonly timeKind: LsTimeKind
  readonly groupDirsFirst: boolean
  readonly columns: LsColumns
  readonly hyperlink: boolean
}

// GNU's own `sort_args`, in its own order, which is what `--sort=x` lists
// back. `name` is deliberately absent: coreutils 9.4 refuses
// `ls --sort=name` (name order is what no `--sort` at all means), and a
// word mirage accepted but GNU did not was also a word missing from the
// list GNU prints.
const SORT_WORDS: Readonly<Record<string, LsSortBy>> = {
  none: 'none',
  time: 'time',
  size: 'size',
  extension: 'extension',
  version: 'version',
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
const HYPERLINK_GROUPS: readonly (readonly string[])[] = [
  ['always', 'yes', 'force'],
  ['never', 'no', 'none'],
  ['auto', 'tty', 'if-tty'],
]

// GNU's ARGMATCH refusal for an option whose values have aliases, listed
// one group per line (--time, --hyperlink); exit 1, as ls answers it. The
// value goes in as typed -- the shared renderer escapes it.
function groupedArgumentError(
  option: string,
  value: string,
  groups: readonly (readonly string[])[],
  kind: ArgmatchKind,
): UsageError {
  return argmatchError('ls', option, value, groups, 1, kind)
}

// The sort key the line asked for, last spelling winning, and whether it
// asked at all.
function sortFlag(fl: FlagView): [SortBy, boolean] {
  const typed = fl.typedOrder('t', 'S', 'X', 'v', 'U', 'sort')
  const last = typed[typed.length - 1]
  if (last === undefined) return ['name', false]
  if (last !== 'sort') return [SORT_FLAGS[last] ?? 'name', true]
  const word = fl.asStr('sort') ?? ''
  const words = Object.keys(SORT_WORDS)
  const match = argmatch(word, words)
  if (!match.matched) {
    throw argmatchError('ls', '--sort', word, words, 1, match.kind)
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
  const match = argmatch(word, TIME_GROUPS)
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
  const match = argmatch(style, LS_TIME_STYLES)
  if (match.matched) return match.word
  // ls hand-writes this block rather than letting argmatch print
  // `time_style_args`, so it is the one ARGMATCH refusal in the repo whose
  // candidates are neither quoted nor a subset of the words it accepts --
  // and the one that exits 2, ls's own `usage (LS_FAILURE)`. The first line
  // is still argmatch's, so `--time-style=lo` spans long-iso and locale and
  // reads `ambiguous argument 'lo'`.
  throw new UsageError(
    `${argmatchLine('ls', 'time style', style, match.kind)}\n` +
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
  const match = argmatch(word, HYPERLINK_GROUPS)
  if (!match.matched) {
    throw groupedArgumentError('--hyperlink', word, HYPERLINK_GROUPS, match.kind)
  }
  return match.word === 'always'
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
  const [askedSort, sortedExplicitly] = sortFlag(fl)
  const timeKind = timeFlag(fl)
  const noOwner = fl.asBool('g')
  const noGroup = fl.asBool('o')
  const long = fl.asBool('args_l') || noOwner || noGroup || fl.asBool('numeric_uid_gid')
  const sortBy: SortBy = !sortedExplicitly && timeKind !== 'mtime' && !long ? 'time' : askedSort
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
    human: fl.asBool('human_readable'),
    reverse: fl.asBool('reverse'),
    classify: fl.asBool('classify'),
    recursive: fl.asBool('recursive'),
    listDir: fl.asBool('directory'),
    deref: fl.asBool('dereference'),
    sortBy,
    timeKind,
    groupDirsFirst: fl.asBool('group_directories_first'),
    columns,
    hyperlink: hyperlinkFlag(fl),
  })
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

export async function lsGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  readdir: Readdir,
  stat: Stat,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('ls'))
  const targets: PathSpec[] =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: opts.cwd,
            directory: opts.cwd,
            resolved: false,
            vfsPath: mountKey(opts.cwd, opts.mountPrefix ?? ''),
          }),
        ]
  const flags = parseFlags(fl)
  const {
    long,
    all,
    human,
    reverse,
    classify,
    recursive,
    sortBy,
    timeKind,
    groupDirsFirst,
    deref,
  } = flags
  const listDirItself = flags.listDir
  const links = opts.ns?.links ?? null
  const identity = identityOf(opts)
  const render: RenderOpts = { long, human, classify, identity, columns: flags.columns }
  const warnings: LsWarning[] = []
  const lines: string[] = []

  if (listDirItself) {
    // -d turns every operand into a plain row, sorted together and printed
    // with no headers.
    const collected: { row: FileStat; href: string }[] = []
    for (const p of targets) {
      const link = linkRow(p, links)
      if (link !== null) {
        collected.push({ row: link, href: p.virtual })
        continue
      }
      try {
        // GNU ls -d prints the operand as given.
        collected.push({ row: asOperand(await stat(p), p), href: p.virtual })
      } catch (err) {
        if (!isWalkError(err)) throw err
        if ((opts.ns?.childMounts?.(p.virtual) ?? []).length > 0) {
          // No backend serves it, but the namespace owes it children,
          // so the door stats it as a directory and -d must print the
          // same row.
          collected.push({
            row: new FileStat({ name: p.rawPath, type: FileType.DIRECTORY }),
            href: p.virtual,
          })
          continue
        }
        warnings.push({
          message: `ls: cannot access '${p.rawPath}': ${errText(err)}`,
          serious: true,
        })
      }
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
          )
        : collected.map((c) => c.row)
    appendListing(rows, render, lines, flags.hyperlink ? rows.map((r) => byRow.get(r) ?? '') : null)
    return finish(lines, warnings)
  }

  const walkOpts: WalkOpts = {
    all,
    sortBy,
    reverse,
    timeKind,
    groupDirsFirst,
    recursive,
    links,
    deref,
    childMounts: opts.ns?.childMounts ?? null,
    mounts: opts.ns?.mounts ?? null,
    statPath: opts.statPath ?? null,
  }
  const probed: Operand[] = []
  for (const p of targets) {
    probed.push(await probeOperand(readdir, stat, p, walkOpts, warnings, true))
  }
  const operands =
    probed.length > 1 ? await sortOperands(probed, sortBy, reverse, stat, timeKind) : probed

  // GNU names every listed directory once there is more than one operand
  // (or under -R); a lone directory operand is listed bare.
  const headed = recursive || targets.length > 1
  const rowed = operands.filter((o) => o.row !== null)
  const rows = rowed.flatMap((o) => (o.row !== null ? [o.row] : []))
  appendListing(rows, render, lines, flags.hyperlink ? rowed.map((o) => o.path.virtual) : null)
  let printed = rows.length > 0
  for (const operand of operands) {
    for (const [dirSpec, entries] of operand.groups) {
      if (headed) {
        if (printed) lines.push('')
        lines.push(`${respellOne(dirSpec.virtual, operand.path.virtual, operand.path.rawPath)}:`)
      }
      appendListing(
        entries,
        render,
        lines,
        flags.hyperlink ? entries.map((e) => `${rstripSlash(dirSpec.virtual)}/${e.name}`) : null,
      )
      printed = true
    }
  }

  return finish(lines, warnings)
}
