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

import type { Accessor } from '../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { walkFind, type WalkFindDeps } from '../../../core/generic/find.ts'
import type { ChildMounts } from '../../../ops/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileType, type PathSpec } from '../../../types.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { readdirOp, statOp } from '../generic/crossmount/utils.ts'
import type { DirProbe, StatFn, WalkFn } from '../generic/archive/walk.ts'
import type { CommandIO } from './adapter.ts'

function walkWith(
  readdir: WalkFindDeps['readdir'],
  stat: WalkFindDeps['stat'],
  index: IndexCacheStore | undefined,
): WalkFn {
  return async (p, findType) => {
    const prefix = mountPrefixOf(p.virtual, p.vfsPath)
    const unreadable: string[] = []
    const keys = await walkFind(p, { unreadable, readdir, stat }, { type: findType }, index)
    const paths = prefix === '' ? keys : keys.map((key) => (key === '/' ? prefix : prefix + key))
    return { paths, unreadable }
  }
}

/**
 * The subtree listing tar and zip both walk with.
 *
 * Reuses find's walk so an archiver classifies an entry exactly the way find
 * does (through stat, never by name). The two calls a directory operand makes
 * share one readdir cache, so the second is answered from the index instead of
 * the backend.
 *
 * walkFind stands in for a backend's native find op, so it answers in
 * mount-relative keys; both archivers name members from virtual paths, so they
 * are lifted back here the way findGeneric lifts them. A directory the walk
 * could not open rides along (as the virtual path the walk recorded), so the
 * archiver can report it the way GNU does instead of silently leaving its
 * contents out.
 */
export function walkOf(
  ops: CommandIO,
  accessor: Accessor,
  index: IndexCacheStore | undefined,
): WalkFn {
  return walkWith(
    (spec, i) => ops.readdir(accessor, spec, i),
    (spec, i) => ops.stat(accessor, spec, i),
    index,
  )
}

/**
 * The directory probe tar's `-C` check uses.
 *
 * Two channels, because a stat miss alone is not absence: on a prefix store
 * a directory is the set of keys under it and nothing answers stat for it,
 * so a readdir that returns anything is the second and deciding opinion.
 */
function isDirWith(stat: StatFn, readdir: (p: PathSpec) => Promise<string[]>): DirProbe {
  return async (p) => {
    try {
      return (await stat(p)).type === FileType.DIRECTORY
    } catch {
      // Not an object of its own; ask the listing instead.
    }
    try {
      return (await readdir(p)).length > 0
    } catch {
      return false
    }
  }
}

export function isDirOf(
  ops: CommandIO,
  accessor: Accessor,
  index: IndexCacheStore | undefined,
): DirProbe {
  return isDirWith(
    (p) => ops.stat(accessor, p, index),
    (p) => ops.readdir(accessor, p, index),
  )
}

/**
 * One directory as its own backend lists it, through the dispatcher.
 *
 * The door adds the names the namespace owes a directory (nested mount roots
 * and symlinks) to every listing. The archive scan adds those itself, from
 * the same tables, and a walk that followed one would descend into a link's
 * target under the link's name or into a mount the scan must not cross, so
 * they are left to the scan.
 */
function ownListing(
  dispatch: DispatchFn,
  owed: ChildMounts | undefined,
): (p: PathSpec) => Promise<string[]> {
  const readdir = readdirOp(dispatch)
  return async (p) => {
    const entries = await readdir(p)
    if (owed === undefined) return entries
    const names = new Set(owed(p.virtual))
    return entries.filter((entry) => {
      const trimmed = rstripSlash(entry)
      return !names.has(trimmed.slice(trimmed.lastIndexOf('/') + 1))
    })
  }
}

/**
 * The subtree listing tar and zip walk with when a line spans mounts.
 *
 * Every directory is listed on the mount that owns it, so operands from
 * several mounts go into one archive, and find's walk classifies what it
 * lists exactly as it does on one backend.
 */
export function relayWalkOf(dispatch: DispatchFn, owed: ChildMounts | undefined): WalkFn {
  return walkWith(ownListing(dispatch, owed), statOp(dispatch), undefined)
}

// The directory probe tar's `-C` check uses when a line spans mounts.
export function relayIsDirOf(dispatch: DispatchFn): DirProbe {
  return isDirWith(statOp(dispatch), readdirOp(dispatch))
}
