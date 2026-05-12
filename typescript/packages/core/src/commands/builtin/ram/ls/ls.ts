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

import { stat as ramStat } from '../../../../core/ram/stat.ts'
import { readdir as ramReaddir } from '../../../../core/ram/readdir.ts'
import type { RAMAccessor } from '../../../../accessor/ram.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { FileStat } from '../../../../types.ts'
import { FileType, PathSpec, ResourceName } from '../../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../../config.ts'
import { formatLsLong } from '../../utils/formatting.ts'
import { specOf } from '../../../spec/builtins.ts'

function childSpec(entryPath: string, prefix: string): PathSpec {
  return new PathSpec({
    original: entryPath,
    directory: entryPath,
    resolved: false,
    prefix,
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
    if (sortBy === 'time') return (b.modified ?? '').localeCompare(a.modified ?? '')
    if (sortBy === 'size') return (b.size ?? 0) - (a.size ?? 0)
    return a.name.localeCompare(b.name)
  })
  if (reverse) sorted.reverse()
  return sorted
}

async function listDir(accessor: RAMAccessor, dir: PathSpec, all: boolean): Promise<FileStat[]> {
  const entries = await ramReaddir(accessor, dir)
  const stats = await Promise.all(entries.map((p) => ramStat(accessor, childSpec(p, dir.prefix))))
  return all ? stats : stats.filter((s) => !s.name.startsWith('.'))
}

async function walkRecursive(
  accessor: RAMAccessor,
  dir: PathSpec,
  opts: {
    all: boolean
    long: boolean
    human: boolean
    classify: boolean
    sortBy: 'time' | 'size' | 'name'
    reverse: boolean
  },
  header: boolean,
  lines: string[],
  warnings: string[],
): Promise<void> {
  let stats: FileStat[]
  try {
    stats = await listDir(accessor, dir, opts.all)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`ls: cannot access '${dir.original}': ${msg}`)
    return
  }
  if (header) lines.push(`${dir.stripPrefix}:`)
  const sorted = sortStats(stats, opts.sortBy, opts.reverse)
  appendListing(sorted, opts.long, opts.human, opts.classify, lines)
  const subdirs = sorted.filter((s) => s.type === FileType.DIRECTORY)
  for (const sub of subdirs) {
    lines.push('')
    const base = dir.stripPrefix.replace(/\/+$/, '')
    const childPath = `${base}/${sub.name}`
    await walkRecursive(accessor, childSpec(childPath, dir.prefix), opts, true, lines, warnings)
  }
}

async function lsCommand(
  accessor: RAMAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const targets: PathSpec[] =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            original: opts.cwd,
            directory: opts.cwd,
            resolved: false,
            prefix: opts.mountPrefix ?? '',
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
  const warnings: string[] = []
  const lines: string[] = []

  if (listDirItself) {
    const collected: FileStat[] = []
    for (const p of targets) {
      try {
        collected.push(await ramStat(accessor, p))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`ls: cannot access '${p.original}': ${msg}`)
      }
    }
    appendListing(collected, long, human, classify, lines)
    const out: ByteSource = new TextEncoder().encode(lines.join('\n'))
    const exitCode = warnings.length > 0 && lines.length === 0 ? 1 : 0
    if (warnings.length > 0) {
      const stderr = new TextEncoder().encode(warnings.join('\n'))
      return [out, new IOResult({ stderr, exitCode })]
    }
    return [out, new IOResult({ exitCode })]
  }

  if (recursive) {
    const walkOpts = { all, long, human, classify, sortBy, reverse }
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]
      if (p === undefined) continue
      if (i > 0) lines.push('')
      await walkRecursive(accessor, p, walkOpts, targets.length > 1 || true, lines, warnings)
    }
    const out: ByteSource = new TextEncoder().encode(lines.join('\n'))
    const exitCode = warnings.length > 0 && lines.length === 0 ? 1 : 0
    if (warnings.length > 0) {
      const stderr = new TextEncoder().encode(warnings.join('\n'))
      return [out, new IOResult({ stderr, exitCode })]
    }
    return [out, new IOResult({ exitCode })]
  }

  for (const p of targets) {
    let stats: FileStat[]
    try {
      stats = await listDir(accessor, p, all)
    } catch (err) {
      try {
        stats = [await ramStat(accessor, p)]
      } catch {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`ls: cannot access '${p.original}': ${msg}`)
        continue
      }
    }
    appendListing(sortStats(stats, sortBy, reverse), long, human, classify, lines)
  }
  const out: ByteSource = new TextEncoder().encode(lines.join('\n'))
  const exitCode = warnings.length > 0 && lines.length === 0 ? 1 : 0
  if (warnings.length > 0) {
    const stderr = new TextEncoder().encode(warnings.join('\n'))
    return [out, new IOResult({ stderr, exitCode })]
  }
  return [out, new IOResult({ exitCode })]
}

export const RAM_LS = command({
  name: 'ls',
  resource: ResourceName.RAM,
  spec: specOf('ls'),
  fn: lsCommand,
})
