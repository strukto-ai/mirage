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
import { FlagView } from '../../spec/types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import type { ChildMounts, LinkView, MountView, StatPath } from '../../../ops/types.ts'
import { formatLsLong } from '../utils/formatting.ts'
import { identityOf, type Identity } from '../utils/identity.ts'
import { gnuStrerror, isEacces, isWalkError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { CycleError, respellOne } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

type Readdir = (p: PathSpec) => Promise<string[]>
type Stat = (p: PathSpec) => Promise<FileStat>
type SortBy = 'time' | 'size' | 'name'

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
    resourcePath: mountKey(entryPath, prefix),
  })
}

// GNU -F suffixes: a directory gets "/", a symlink "@". The link mark
// rides the row's type, so it needs no separate lookup.
const CLASSIFY_SUFFIX: Partial<Record<FileType, string>> = {
  [FileType.DIRECTORY]: '/',
  [FileType.SYMLINK]: '@',
}

function formatShort(s: FileStat, classify: boolean): string {
  const suffix = (classify ? CLASSIFY_SUFFIX[s.type] : undefined) ?? ''
  return `${s.name}${suffix}`
}

function appendListing(
  stats: readonly FileStat[],
  long: boolean,
  human: boolean,
  classify: boolean,
  identity: Identity,
  lines: string[],
): void {
  if (long) {
    for (const line of formatLsLong(stats, { human, identity })) lines.push(line)
    return
  }
  for (const s of stats) lines.push(formatShort(s, classify))
}

function primaryValue(entry: FileStat, sortBy: SortBy): string | number {
  return sortBy === 'time' ? (entry.modified ?? '') : (entry.size ?? 0)
}

// GNU's -t/-S comparators fall back to the name when the timestamps or sizes
// tie, so the order is total. `-r` negates the whole comparison, tie-break
// included, which is why callers fold the sign into this comparator instead of
// reversing the finished array.
function compareStats(a: FileStat, b: FileStat, sortBy: SortBy): number {
  if (sortBy !== 'name') {
    const av = primaryValue(a, sortBy)
    const bv = primaryValue(b, sortBy)
    // -t and -S list newest/largest first.
    if (av < bv) return 1
    if (av > bv) return -1
  }
  return compareCodePoints(a.name, b.name)
}

function sortStats(stats: readonly FileStat[], sortBy: SortBy, reverse: boolean): FileStat[] {
  const sign = reverse ? -1 : 1
  return [...stats].sort((a, b) => sign * compareStats(a, b, sortBy))
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
  const prefix = mountPrefixOf(dir.virtual, dir.resourcePath)
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
  const spec = childSpec(target, mountPrefixOf(directory.virtual, directory.resourcePath))
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
  const entries = sortStats(stats, opts.sortBy, opts.reverse)
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
        childSpec(childPath, mountPrefixOf(path.virtual, path.resourcePath)),
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
): Promise<Operand[]> {
  const keyed: { key: FileStat; operand: Operand }[] = []
  for (const operand of operands) {
    keyed.push({ key: await operandKey(operand, sortBy, stat), operand })
  }
  const sign = reverse ? -1 : 1
  keyed.sort((a, b) => sign * compareStats(a.key, b.key, sortBy))
  return keyed.map((k) => k.operand)
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
            resourcePath: mountKey(opts.cwd, opts.mountPrefix ?? ''),
          }),
        ]
  const long = fl.asBool('args_l') && !fl.asBool('args_1')
  const all = fl.asBool('a') || fl.asBool('A')
  const human = fl.asBool('h')
  const reverse = fl.asBool('r')
  const classify = fl.asBool('F')
  const recursive = fl.asBool('R')
  const listDirItself = fl.asBool('d')
  const sortBy: SortBy = fl.asBool('t') ? 'time' : fl.asBool('S') ? 'size' : 'name'
  const links = opts.ns?.links ?? null
  const deref = fl.asBool('L')
  const identity = identityOf(opts)
  const warnings: LsWarning[] = []
  const lines: string[] = []

  if (listDirItself) {
    // -d turns every operand into a plain row, sorted together and printed
    // with no headers.
    const collected: FileStat[] = []
    for (const p of targets) {
      const link = linkRow(p, links)
      if (link !== null) {
        collected.push(link)
        continue
      }
      try {
        // GNU ls -d prints the operand as given.
        collected.push(asOperand(await stat(p), p))
      } catch (err) {
        if (!isWalkError(err)) throw err
        if ((opts.ns?.childMounts?.(p.virtual) ?? []).length > 0) {
          // No backend serves it, but the namespace owes it children,
          // so the door stats it as a directory and -d must print the
          // same row.
          collected.push(new FileStat({ name: p.rawPath, type: FileType.DIRECTORY }))
          continue
        }
        warnings.push({
          message: `ls: cannot access '${p.rawPath}': ${errText(err)}`,
          serious: true,
        })
      }
    }
    const rows = collected.length > 1 ? sortStats(collected, sortBy, reverse) : collected
    appendListing(rows, long, human, classify, identity, lines)
    return finish(lines, warnings)
  }

  const walkOpts: WalkOpts = {
    all,
    sortBy,
    reverse,
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
  const operands = probed.length > 1 ? await sortOperands(probed, sortBy, reverse, stat) : probed

  // GNU names every listed directory once there is more than one operand
  // (or under -R); a lone directory operand is listed bare.
  const headed = recursive || targets.length > 1
  const rows = operands.flatMap((o) => (o.row !== null ? [o.row] : []))
  appendListing(rows, long, human, classify, identity, lines)
  let printed = rows.length > 0
  for (const operand of operands) {
    for (const [dirSpec, entries] of operand.groups) {
      if (headed) {
        if (printed) lines.push('')
        lines.push(`${respellOne(dirSpec.virtual, operand.path.virtual, operand.path.rawPath)}:`)
      }
      appendListing(entries, long, human, classify, identity, lines)
      printed = true
    }
  }

  return finish(lines, warnings)
}
