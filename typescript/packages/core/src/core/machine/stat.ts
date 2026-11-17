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

import type { MachineAccessor } from '../../accessor/machine.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { epochToIso } from '../../utils/dates.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { refusal } from '../posix/errors.ts'
import { parseTree, treeCommand } from '../posix/stat.ts'
import type { TreeRow } from '../posix/types.ts'
import { KINDS } from './constants.ts'
import { checked, remote } from './utils.ts'

/**
 * A machine's entry as `stat` renders it: its kind, mode, times and owners
 * as the machine has them.
 *
 * @param name the entry's name.
 * @param row what find printed for it.
 */
export function rowStat(name: string, row: TreeRow): FileStat {
  const kind = KINDS[row.kind] ?? FileType.FILE
  const modified = epochToIso(row.mtime)
  const regular = kind === FileType.FILE
  return new FileStat({
    name,
    size: regular ? row.size : null,
    modified,
    fingerprint: modified,
    type: kind,
    ...(regular ? { content: contentTypeForPath(name) } : {}),
    mode: row.mode,
    uid: row.user,
    gid: row.group,
    atime: epochToIso(row.atime),
  })
}

/**
 * What find on a machine prints for a path and what is below it, the
 * path's own row first.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the path.
 * @param depth 0 for the path alone, 1 for its children, null for
 *   everything below.
 */
export async function rows(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  depth: number | null,
): Promise<TreeRow[]> {
  const out = await checked(accessor, machine, treeCommand(remote(accessor, path), depth), path)
  const found = parseTree(out)
  if (found?.[0]?.rel !== '') throw refusal(path, new Uint8Array())
  return found
}

/**
 * A path's row on one machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the path.
 */
export async function statRow(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<TreeRow> {
  const [row] = await rows(accessor, machine, path, 0)
  if (row === undefined) throw refusal(path, new Uint8Array())
  return row
}

/**
 * A path's stat on one machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the path.
 */
export async function stat(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<FileStat> {
  const last = path.mountPath.replace(/\/+$/, '').split('/').pop() ?? ''
  const name = last === '' ? '/' : last
  return rowStat(name, await statRow(accessor, machine, path))
}

/**
 * Every entry under a directory on the machines that hold it, merged by
 * path, from one find on each, where a walk sends a listing per directory.
 * A machine whose find fails leaves the walk to readdir, which reports it.
 *
 * @param accessor the mount's machines.
 * @param machines the machines holding the directory.
 * @param path the directory.
 */
export async function tree(
  accessor: MachineAccessor,
  machines: string[],
  path: PathSpec,
): Promise<Map<string, FileStat> | null> {
  const found = await Promise.allSettled(machines.map((m) => rows(accessor, m, path, null)))
  const merged = new Map<string, FileStat>()
  for (const listed of found) {
    if (listed.status === 'rejected') {
      if (!(listed.reason instanceof Error) || !('code' in listed.reason)) throw listed.reason
      return null
    }
    const [top, ...below] = listed.value
    if (top?.kind !== 'd') return null
    for (const row of below) {
      if (!merged.has(row.rel))
        merged.set(row.rel, rowStat(row.rel.split('/').pop() ?? row.rel, row))
    }
  }
  return merged
}
