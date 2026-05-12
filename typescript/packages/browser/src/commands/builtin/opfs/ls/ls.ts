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
  formatLsLong,
  specOf,
  type ByteSource,
  type CommandFnResult,
  type CommandOpts,
} from '@struktoai/mirage-core'
import { stat as opfsStat } from '../../../../core/opfs/stat.ts'
import { readdir as opfsReaddir } from '../../../../core/opfs/readdir.ts'
import type { OPFSAccessor } from '../../../../accessor/opfs.ts'

async function lsCommand(
  accessor: OPFSAccessor,
  paths: PathSpec[],
  texts: string[],
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
  const sortBy = opts.flags.t === true ? 'time' : opts.flags.S === true ? 'size' : 'name'
  const warnings: string[] = []
  const lines: string[] = []
  for (const p of targets) {
    let stats
    try {
      const entries = await opfsReaddir(accessor.rootHandle, p)
      stats = await Promise.all(
        entries.map((entryPath) =>
          opfsStat(
            accessor.rootHandle,
            new PathSpec({
              original: entryPath,
              directory: entryPath,
              resolved: false,
              prefix: p.prefix,
            }),
          ),
        ),
      )
    } catch (err) {
      // not a directory — try treating it as a single entry (matches real `ls foo.txt`)
      try {
        stats = [await opfsStat(accessor.rootHandle, p)]
      } catch {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(`ls: cannot access '${p.original}': ${msg}`)
        continue
      }
    }
    let filtered = stats
    if (!all) filtered = filtered.filter((s) => !s.name.startsWith('.'))
    filtered.sort((a, b) => {
      if (sortBy === 'time') {
        return (b.modified ?? '').localeCompare(a.modified ?? '')
      }
      if (sortBy === 'size') {
        return (b.size ?? 0) - (a.size ?? 0)
      }
      return a.name.localeCompare(b.name)
    })
    if (reverse) filtered.reverse()
    if (long) {
      for (const line of formatLsLong(filtered, { human })) lines.push(line)
    } else {
      for (const s of filtered) {
        const suffix = classify && s.type === FileType.DIRECTORY ? '/' : ''
        lines.push(`${s.name}${suffix}`)
      }
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

export const OPFS_LS = command({
  name: 'ls',
  resource: ResourceName.OPFS,
  spec: specOf('ls'),
  fn: lsCommand,
})
