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

import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { formatLsLong } from '../utils/formatting.ts'
import { gnuStrerror } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { rebaseOne } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'

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

function formatShort(s: FileStat, classify: boolean): string {
  const suffix = classify && s.type === FileType.DIRECTORY ? '/' : ''
  return `${s.name}${suffix}`
}

function appendListing(
  stats: readonly FileStat[],
  long: boolean,
  human: boolean,
  classify: boolean,
  lines: string[],
): void {
  if (long) {
    for (const line of formatLsLong(stats, { human })) lines.push(line)
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
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
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
  } catch {
    return null
  }
}

// GNU ls prints a file operand as given (`ls sub/x.txt` shows sub/x.txt,
// not x.txt); the row carries the operand spelling. Every other field
// (mode/uid/gid/atime overlay attrs included) is preserved, mirroring the
// Python `s.model_copy(update={"name": ...})`.
function asOperand(s: FileStat, path: PathSpec): FileStat {
  return new FileStat({
    name: path.rawPath,
    size: s.size,
    modified: s.modified,
    fingerprint: s.fingerprint,
    revision: s.revision,
    type: s.type,
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    atime: s.atime,
    extra: s.extra,
  })
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
): Promise<FileStat[]> {
  const entries = await readdir(dir)
  const prefix = mountPrefixOf(dir.virtual, dir.resourcePath)
  const settled = await Promise.allSettled(entries.map((p) => stat(childSpec(p, prefix))))
  const stats: FileStat[] = []
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]
    const entry = entries[i]
    if (outcome === undefined || entry === undefined) continue
    if (outcome.status === 'rejected') {
      // An entry below an operand is never a command-line arg.
      warnings.push({
        message: `ls: cannot access '${entry}': ${errText(outcome.reason)}`,
        serious: false,
      })
      continue
    }
    stats.push(outcome.value)
  }
  return all ? stats : stats.filter((s) => !s.name.startsWith('.'))
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
  try {
    stats = await listDir(readdir, stat, path, opts.all, warnings)
  } catch (err) {
    const row = await fileEntry(stat, path)
    if (row !== null) return { path, row, groups: [] }
    warnings.push({
      message: `ls: cannot access '${path.rawPath}': ${errText(err)}`,
      serious: commandLineArg,
    })
    return { path, row: null, groups: [] }
  }
  if (stats.length === 0) {
    const row = await fileEntry(stat, path)
    if (row !== null) return { path, row, groups: [] }
  }
  const entries = sortStats(stats, opts.sortBy, opts.reverse)
  const groups: [PathSpec, FileStat[]][] = [[path, entries]]
  if (opts.recursive) {
    for (const s of entries) {
      if (s.type !== FileType.DIRECTORY) continue
      const childPath = `${rstripSlash(path.virtual)}/${s.name}`
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
  } catch {
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
  const long = opts.flags.args_l === true && opts.flags.args_1 !== true
  const all = opts.flags.a === true || opts.flags.A === true
  const human = opts.flags.h === true
  const reverse = opts.flags.r === true
  const classify = opts.flags.F === true
  const recursive = opts.flags.R === true
  const listDirItself = opts.flags.d === true
  const sortBy: SortBy = opts.flags.t === true ? 'time' : opts.flags.S === true ? 'size' : 'name'
  const warnings: LsWarning[] = []
  const lines: string[] = []

  if (listDirItself) {
    // -d turns every operand into a plain row, sorted together and printed
    // with no headers.
    const collected: FileStat[] = []
    for (const p of targets) {
      try {
        // GNU ls -d prints the operand as given.
        collected.push(asOperand(await stat(p), p))
      } catch (err) {
        warnings.push({
          message: `ls: cannot access '${p.rawPath}': ${errText(err)}`,
          serious: true,
        })
      }
    }
    const rows = collected.length > 1 ? sortStats(collected, sortBy, reverse) : collected
    appendListing(rows, long, human, classify, lines)
    return finish(lines, warnings)
  }

  const walkOpts: WalkOpts = { all, sortBy, reverse, recursive }
  const probed: Operand[] = []
  for (const p of targets) {
    probed.push(await probeOperand(readdir, stat, p, walkOpts, warnings, true))
  }
  const operands = probed.length > 1 ? await sortOperands(probed, sortBy, reverse, stat) : probed

  // GNU names every listed directory once there is more than one operand
  // (or under -R); a lone directory operand is listed bare.
  const headed = recursive || targets.length > 1
  const rows = operands.flatMap((o) => (o.row !== null ? [o.row] : []))
  appendListing(rows, long, human, classify, lines)
  let printed = rows.length > 0
  for (const operand of operands) {
    for (const [dirSpec, entries] of operand.groups) {
      if (headed) {
        if (printed) lines.push('')
        lines.push(`${rebaseOne(dirSpec.virtual, operand.path.virtual, operand.path.rawPath)}:`)
      }
      appendListing(entries, long, human, classify, lines)
      printed = true
    }
  }

  return finish(lines, warnings)
}
