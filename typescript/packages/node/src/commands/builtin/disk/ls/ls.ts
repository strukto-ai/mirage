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

import {
  FileType,
  IOResult,
  PathSpec,
  ResourceName,
  command,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
  type FileStat,
} from '@struktoai/mirage-core'
import { stat as diskStat } from '../../../../core/disk/stat.ts'
import { readdir as diskReaddir } from '../../../../core/disk/readdir.ts'
import type { DiskAccessor } from '../../../../accessor/disk.ts'

function humanSize(n: number): string {
  const units = ['B', 'K', 'M', 'G', 'T']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const s = v >= 10 || i === 0 ? Math.round(v).toString() : v.toFixed(1)
  return `${s}${units[i] ?? ''}`
}

function childSpec(entryPath: string, prefix: string): PathSpec {
  return new PathSpec({
    original: entryPath,
    directory: entryPath,
    resolved: false,
    prefix,
  })
}

function formatEntry(s: FileStat, long: boolean, human: boolean, classify: boolean): string {
  if (long) {
    const size = human ? humanSize(s.size ?? 0) : String(s.size ?? 0)
    return `${s.type ?? '-'}\t${size}\t${s.modified ?? ''}\t${s.name}`
  }
  const suffix = classify && s.type === FileType.DIRECTORY ? '/' : ''
  return `${s.name}${suffix}`
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

async function listDir(accessor: DiskAccessor, dir: PathSpec, all: boolean): Promise<FileStat[]> {
  const entries = await diskReaddir(accessor, dir)
  const stats = await Promise.all(entries.map((p) => diskStat(accessor, childSpec(p, dir.prefix))))
  return all ? stats : stats.filter((s) => !s.name.startsWith('.'))
}

interface WalkOpts {
  all: boolean
  long: boolean
  human: boolean
  classify: boolean
  sortBy: 'time' | 'size' | 'name'
  reverse: boolean
}

async function walkRecursive(
  accessor: DiskAccessor,
  dir: PathSpec,
  opts: WalkOpts,
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
  for (const s of sorted) lines.push(formatEntry(s, opts.long, opts.human, opts.classify))
  const subdirs = sorted.filter((s) => s.type === FileType.DIRECTORY)
  for (const sub of subdirs) {
    lines.push('')
    const base = dir.stripPrefix.replace(/\/+$/, '')
    const childPath = `${base}/${sub.name}`
    await walkRecursive(accessor, childSpec(childPath, dir.prefix), opts, true, lines, warnings)
  }
}

async function lsCommand(
  accessor: DiskAccessor,
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
    for (const p of targets) {
      try {
        const s = await diskStat(accessor, p)
        lines.push(formatEntry(s, long, human, classify))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`ls: cannot access '${p.original}': ${msg}`)
      }
    }
    const out: ByteSource = new TextEncoder().encode(lines.join('\n'))
    const exitCode = warnings.length > 0 && lines.length === 0 ? 1 : 0
    if (warnings.length > 0) {
      const stderr = new TextEncoder().encode(warnings.join('\n'))
      return [out, new IOResult({ stderr, exitCode })]
    }
    return [out, new IOResult({ exitCode })]
  }

  if (recursive) {
    const walkOpts: WalkOpts = { all, long, human, classify, sortBy, reverse }
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]
      if (p === undefined) continue
      if (i > 0) lines.push('')
      await walkRecursive(accessor, p, walkOpts, true, lines, warnings)
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
        stats = [await diskStat(accessor, p)]
      } catch {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`ls: cannot access '${p.original}': ${msg}`)
        continue
      }
    }
    for (const s of sortStats(stats, sortBy, reverse))
      lines.push(formatEntry(s, long, human, classify))
  }
  const out: ByteSource = new TextEncoder().encode(lines.join('\n'))
  const exitCode = warnings.length > 0 && lines.length === 0 ? 1 : 0
  if (warnings.length > 0) {
    const stderr = new TextEncoder().encode(warnings.join('\n'))
    return [out, new IOResult({ stderr, exitCode })]
  }
  return [out, new IOResult({ exitCode })]
}

export const DISK_LS = command({
  name: 'ls',
  resource: ResourceName.DISK,
  spec: specOf('ls'),
  fn: lsCommand,
})
