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
import { msToRfc3339 } from '../../utils/dates.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { refusal } from '../posix/errors.ts'
import { parseTree, treeCommand } from '../posix/stat.ts'
import type { TreeRow } from '../posix/types.ts'
import { KINDS } from './constants.ts'
import { checked, mountBase, remote, virtualOf } from './utils.ts'
import { currentCaller } from '../../context/session_context.ts'
import { hiddenUnder, pathVisible } from '../../utils/hidden.ts'
import { norm } from '../../utils/path.ts'
import { singleQuote } from '../../utils/quote.ts'
import { rstripSlash } from '../../utils/slash.ts'

/**
 * A machine's entry as `stat` renders it: its kind, mode, times and owners
 * as the machine has them.
 *
 * @param name the entry's name.
 * @param row what find printed for it.
 */
export function rowStat(name: string, row: TreeRow): FileStat {
  const kind = KINDS[row.kind] ?? FileType.FILE
  const modified = msToRfc3339(row.mtimeMs)
  const regular = kind === FileType.FILE
  return new FileStat({
    name,
    size: regular ? row.size : null,
    modified,
    fingerprint: modified,
    type: kind,
    ...(regular ? { content: contentTypeForPath(name) } : {}),
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
    atime: msToRfc3339(row.atimeMs),
    nlink: row.nlink,
    blocks: row.blocks,
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
  const last = rstripSlash(path.mountPath).split('/').pop() ?? ''
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
      console.debug(`${path.virtual}: one find failed; walking it instead:`, listed.reason)
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

/**
 * Whether the running session hides anything in the mount `path` is on,
 * where a machine's own links may lead to a hidden name. Mirrors Python's
 * `restricted`.
 *
 * @param path a path on the mount.
 */
export function restricted(path: PathSpec): boolean {
  return hiddenUnder(currentCaller().session?.visibility ?? null, mountBase(path))
}

/**
 * The machines on which `path` resolves, through the machine's own links, to
 * a name the running session hides: `/tmp/public` linked to a hidden
 * `/tmp/secret` reads the secret on the machine, where Mirage checks only its
 * own link table. Each machine answers for itself, so another machine's
 * visible files at the path stay; none is asked for a session that hides
 * nothing in the mount. Mirrors Python's `hidden_on`.
 *
 * @param accessor the mount's machines.
 * @param path the path an op names.
 */
export async function hiddenOn(accessor: MachineAccessor, path: PathSpec): Promise<string[]> {
  const vis = currentCaller().session?.visibility ?? null
  if (!hiddenUnder(vis, mountBase(path))) return []
  const q = singleQuote(remote(accessor, path))
  const hidden: string[] = []
  for (const machine of accessor.names()) {
    const [status, out] = await accessor.run(machine, `readlink -f -- ${q}`)
    if (status !== 0) continue
    const real = new TextDecoder().decode(out).replace(/\n$/, '')
    const seen = virtualOf(accessor, path, real)
    if (seen !== null && seen !== norm(path.virtual) && !pathVisible(vis, seen))
      hidden.push(machine)
  }
  return hidden
}
