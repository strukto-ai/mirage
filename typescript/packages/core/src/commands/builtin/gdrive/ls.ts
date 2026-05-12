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

import type { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { resolveGlob } from '../../../core/gdrive/glob.ts'
import { readdir as gdriveReaddir } from '../../../core/gdrive/readdir.ts'
import { stat as gdriveStat } from '../../../core/gdrive/stat.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FileStat } from '../../../types.ts'
import { FileType, PathSpec, ResourceName } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { humanSize } from '../utils/formatting.ts'
import { metadataProvision } from './provision.ts'

const ENC = new TextEncoder()

async function lsEntries(
  accessor: GDriveAccessor,
  path: PathSpec,
  allFiles: boolean,
  sortBy: 'name' | 'size',
  reverse: boolean,
  recursive: boolean,
  listDir: boolean,
  warnings: string[],
  indexCache: CommandOpts['index'],
): Promise<FileStat[]> {
  if (listDir) {
    const s = await gdriveStat(accessor, path, indexCache ?? undefined)
    return [s]
  }
  let entries: string[]
  try {
    entries = await gdriveReaddir(accessor, path, indexCache ?? undefined)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`ls: cannot access '${path.original}': ${msg}`)
    return []
  }
  const stats: FileStat[] = []
  for (const entry of entries) {
    try {
      const eSpec = new PathSpec({
        original: entry,
        directory: entry,
        resolved: false,
        prefix: path.prefix,
      })
      const s = await gdriveStat(accessor, eSpec, indexCache ?? undefined)
      if (!allFiles && s.name.startsWith('.')) continue
      stats.push(s)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`ls: cannot access '${entry}': ${msg}`)
    }
  }
  if (sortBy === 'size') {
    stats.sort((a, b) => (a.size ?? 0) - (b.size ?? 0))
    if (!reverse) stats.reverse()
  } else {
    stats.sort((a, b) => a.name.localeCompare(b.name))
    if (reverse) stats.reverse()
  }
  if (recursive) {
    const subEntries: FileStat[] = []
    for (const s of stats) {
      subEntries.push(s)
      if (s.type === FileType.DIRECTORY) {
        const childPath = path.child(s.name)
        const childSpec = new PathSpec({
          original: childPath,
          directory: childPath,
          resolved: false,
          prefix: path.prefix,
        })
        const sub = await lsEntries(
          accessor,
          childSpec,
          allFiles,
          sortBy,
          reverse,
          recursive,
          false,
          warnings,
          indexCache,
        )
        subEntries.push(...sub)
      }
    }
    return subEntries
  }
  return stats
}

async function lsCommand(
  accessor: GDriveAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
  const targets: PathSpec[] =
    resolved.length > 0
      ? resolved
      : [
          new PathSpec({
            original: opts.cwd,
            directory: opts.cwd,
            resolved: false,
            prefix: opts.mountPrefix ?? '',
          }),
        ]
  const long = opts.flags.args_l === true && opts.flags.args_1 !== true
  const allFiles = opts.flags.a === true || opts.flags.A === true
  const human = opts.flags.h === true
  const reverse = opts.flags.r === true
  const recursive = opts.flags.R === true
  const listDir = opts.flags.d === true
  const classify = opts.flags.F === true
  const sortBy: 'name' | 'size' = opts.flags.S === true ? 'size' : 'name'
  const warnings: string[] = []
  const results: string[] = []
  for (const p of targets) {
    let entries: FileStat[]
    try {
      entries = await lsEntries(
        accessor,
        p,
        allFiles,
        sortBy,
        reverse,
        recursive,
        listDir,
        warnings,
        opts.index,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`ls: cannot access '${p.original}': ${msg}`)
      continue
    }
    if (long) {
      for (const e of entries) {
        const sizeStr = human ? humanSize(e.size ?? 0) : String(e.size ?? 0)
        results.push(`${e.type ?? '-'}\t${sizeStr}\t${e.modified ?? ''}\t${e.name}`)
      }
    } else {
      for (const e of entries) {
        const isDir = classify && e.type === FileType.DIRECTORY
        const name = isDir ? e.name + '/' : e.name
        results.push(name)
      }
    }
  }
  const stderr = warnings.length > 0 ? ENC.encode(warnings.join('\n')) : null
  const exitCode = warnings.length > 0 && results.length === 0 ? 1 : 0
  const out: ByteSource = ENC.encode(results.join('\n'))
  return [out, new IOResult({ stderr, exitCode })]
}

export const GDRIVE_LS = command({
  name: 'ls',
  resource: ResourceName.GDRIVE,
  spec: specOf('ls'),
  fn: lsCommand,
  provision: metadataProvision,
})
