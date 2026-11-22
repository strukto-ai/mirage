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
import { parseEntries, treeCommand } from '../posix/stat.ts'
import type { PosixEntry } from '../posix/types.ts'
import { KINDS } from './constants.ts'
import type { Holder } from './types.ts'
import { checked, leaf, mountBase, remote, virtualOf } from './utils.ts'
import { currentCaller } from '../../context/session_context.ts'
import { hiddenUnder, pathVisible } from '../../utils/hidden.ts'
import { norm } from '../../utils/path.ts'
import { singleQuote } from '../../utils/quote.ts'

/**
 * A machine's entry as `stat` renders it: its kind, mode, times and owners
 * as the machine has them.
 *
 * @param name the entry's name.
 * @param entry what find printed for it.
 */
export function entryStat(name: string, entry: PosixEntry): FileStat {
  const kind = KINDS[entry.kind] ?? FileType.FILE
  const modified = msToRfc3339(entry.mtimeMs)
  const regular = kind === FileType.FILE
  return new FileStat({
    name,
    size: regular ? entry.size : null,
    modified,
    fingerprint: modified,
    type: kind,
    ...(regular ? { content: contentTypeForPath(name) } : {}),
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    atime: msToRfc3339(entry.atimeMs),
    nlink: entry.nlink,
    blocks: entry.blocks,
  })
}

/**
 * A machine's copy of a name as `stat` renders it, from the entry the
 * machine was asked for.
 *
 * @param name the entry's name.
 * @param one the machine and the entry it reported.
 */
export function holderStat(name: string, one: Holder): FileStat {
  if (one.entry === null) throw new Error(`${one.machine}: no entry was asked for ${name}`)
  return entryStat(name, one.entry)
}

/**
 * What find on a machine prints for a path and what is below it, the
 * path's own entry first.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the path.
 * @param depth 0 for the path alone, 1 for its children, null for
 *   everything below.
 */
export async function entries(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
  depth: number | null,
): Promise<PosixEntry[]> {
  const out = await checked(accessor, machine, treeCommand(remote(accessor, path), depth), path)
  const found = parseEntries(out)
  if (found?.[0]?.rel !== '') throw refusal(path, new Uint8Array())
  return found
}

/**
 * A path's entry on one machine.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param path the path.
 */
export async function statEntry(
  accessor: MachineAccessor,
  machine: string,
  path: PathSpec,
): Promise<PosixEntry> {
  const [entry] = await entries(accessor, machine, path, 0)
  if (entry === undefined) throw refusal(path, new Uint8Array())
  return entry
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
  return entryStat(leaf(path), await statEntry(accessor, machine, path))
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
