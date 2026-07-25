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
  sortBy: 'time' | 'size' | 'name'
  reverse: boolean
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

function sortStats(
  stats: FileStat[],
  sortBy: 'time' | 'size' | 'name',
  reverse: boolean,
): FileStat[] {
  const sorted = [...stats].sort((a, b) => {
    if (sortBy === 'time') {
      const am = a.modified ?? ''
      const bm = b.modified ?? ''
      return am < bm ? 1 : am > bm ? -1 : 0
    }
    if (sortBy === 'size') return (b.size ?? 0) - (a.size ?? 0)
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  if (reverse) sorted.reverse()
  return sorted
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
// 1. Mirrors the per-entry tolerance of Python ls `walk`.
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

async function walkGrouped(
  readdir: Readdir,
  stat: Stat,
  dir: PathSpec,
  opts: WalkOpts,
  groups: [PathSpec, FileStat[]][],
  warnings: LsWarning[],
  commandLineArg: boolean,
): Promise<void> {
  let stats: FileStat[]
  try {
    stats = await listDir(readdir, stat, dir, opts.all, warnings)
  } catch (err) {
    warnings.push({
      message: `ls: cannot access '${dir.rawPath}': ${errText(err)}`,
      serious: commandLineArg,
    })
    return
  }
  const sorted = sortStats(stats, opts.sortBy, opts.reverse)
  groups.push([dir, sorted])
  for (const s of sorted) {
    if (s.type === FileType.DIRECTORY) {
      const base = rstripSlash(dir.virtual)
      const childPath = `${base}/${s.name}`
      await walkGrouped(
        readdir,
        stat,
        childSpec(childPath, mountPrefixOf(dir.virtual, dir.resourcePath)),
        opts,
        groups,
        warnings,
        false,
      )
    }
  }
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
  const sortBy: 'time' | 'size' | 'name' =
    opts.flags.t === true ? 'time' : opts.flags.S === true ? 'size' : 'name'
  const warnings: LsWarning[] = []
  const lines: string[] = []

  if (listDirItself) {
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
    appendListing(collected, long, human, classify, lines)
    return finish(lines, warnings)
  }

  if (recursive) {
    const walkOpts: WalkOpts = { all, sortBy, reverse }
    const groups: [PathSpec, FileStat[]][] = []
    for (const p of targets) {
      await walkGrouped(readdir, stat, p, walkOpts, groups, warnings, true)
    }
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      if (group === undefined) continue
      const [dirSpec, entries] = group
      if (i > 0) lines.push('')
      const owner =
        targets.find((t) => {
          const b = rstripSlash(t.virtual)
          return dirSpec.virtual === b || dirSpec.virtual.startsWith(b + '/')
        }) ?? dirSpec
      lines.push(`${rebaseOne(dirSpec.virtual, owner.virtual, owner.rawPath)}:`)
      appendListing(entries, long, human, classify, lines)
    }
    return finish(lines, warnings)
  }

  for (const p of targets) {
    let stats: FileStat[]
    try {
      stats = await listDir(readdir, stat, p, all, warnings)
    } catch (err) {
      try {
        stats = [asOperand(await stat(p), p)]
      } catch {
        warnings.push({
          message: `ls: cannot access '${p.rawPath}': ${errText(err)}`,
          serious: true,
        })
        continue
      }
    }
    if (stats.length === 0) {
      const fe = await fileEntry(stat, p)
      if (fe !== null) stats = [fe]
    }
    appendListing(sortStats(stats, sortBy, reverse), long, human, classify, lines)
  }
  return finish(lines, warnings)
}
