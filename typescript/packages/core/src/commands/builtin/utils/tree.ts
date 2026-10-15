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

import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { classify } from '../../../errors/classify.ts'
import { isFsError } from '../../../errors/fs.ts'
import type { FsCondition, WalkDeclinedError } from '../../../errors/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { UsageError } from '../../errors.ts'

// The conditions under which a guard's path reaches no directory to scan.
const NO_DIRECTORY: ReadonlySet<FsCondition> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

export type ReadTree = (path: PathSpec) => Promise<Map<string, FileStat> | null>

export type WalkCall<R> = (
  path: PathSpec,
  index?: IndexCacheStore,
  nofollow?: boolean,
) => Promise<R>

/**
 * Let the mount that owns `path` refuse a command about to read every file
 * under it. The mount is asked at the resolved path: the command already
 * judged the spelling it was typed in, and reports a path that reaches no
 * directory (missing, not one, a link loop) itself. The mount refuses by
 * rejecting, which becomes the command's own error, `command: message` and
 * exit 1, on one mount or across several; any other filesystem error stays
 * one. Mirrors Python's `before_full_scan`.
 */
export async function beforeFullScan(
  dispatch: DispatchFn | undefined,
  path: PathSpec,
  command: string,
): Promise<void> {
  if (dispatch === undefined) return
  try {
    await dispatch('before_full_scan', PathSpec.fromStrPath(path.virtual))
  } catch (err) {
    const condition = classify(err)
    if (condition !== null && NO_DIRECTORY.has(condition)) {
      console.debug(`scan guard at ${path.virtual}: ${String(err)}`)
      return
    }
    if (err instanceof UsageError || isFsError(err) || !(err instanceof Error)) throw err
    throw new UsageError(`${command}: ${err.message}`, 1)
  }
}

// Each directory's children in name order, keyed by its path below the walk's
// root ('' for the root itself). A directory a deeper key implies is added to
// `found` as a bare one. Mirrors Python's `_listings`.
function listings(found: Map<string, FileStat>): Map<string, string[]> {
  const children = new Map<string, Set<string>>([['', new Set()]])
  for (const [key, st] of found) {
    const parts = key.split('/')
    for (let depth = 1; depth <= parts.length; depth++) {
      const parent = parts.slice(0, depth - 1).join('/')
      const rel = parts.slice(0, depth).join('/')
      let set = children.get(parent)
      if (set === undefined) {
        set = new Set()
        children.set(parent, set)
      }
      set.add(rel)
    }
    if (st.type === FileType.DIRECTORY && !children.has(key)) children.set(key, new Set())
  }
  for (const rel of children.keys()) {
    if (rel !== '' && !found.has(rel)) {
      found.set(rel, new FileStat({ name: rel.split('/').pop() ?? rel, type: FileType.DIRECTORY }))
    }
  }
  const out = new Map<string, string[]>()
  for (const [rel, names] of children) {
    out.set(rel, [...names].sort(compareCodePoints))
  }
  return out
}

/**
 * A walk's `readdir` and `stat`, answered from the mount's `readTree`.
 *
 * The first `readdir` of a directory no answer covers asks `readTree` for
 * everything under it, and every later `readdir` and `stat` below it answers
 * from that, so a walk costs one call. An answer of null, a mount without
 * `readTree`, or a dispatcher that declines it (a path rule below the
 * directory) leaves the walk to `readdir` and `stat`, each judged on its own,
 * as does a path the answer does not hold; under a hide the dispatcher
 * answers without the hidden entries. Both take the path and the
 * index the walk passes. `answered` collects each directory listed
 * from an answer, for a walk that charges a budget per request. Mirrors
 * Python's `tree_walk`.
 */
/**
 * Whether an earlier answer may stand for `path`. A spelling with dots or a
 * trailing slash (`dotted`) or one the walk refused (`walkError`) goes to the
 * call, so the dispatcher checks it. Mirrors Python's `_answerable`.
 */
function answerable(path: PathSpec): boolean {
  return path.dotted === null && path.walkError === null
}

export function treeWalk<D, S>(
  readTree: ReadTree | undefined,
  readdir: WalkCall<D>,
  stat: WalkCall<S>,
  answered?: Set<string>,
): [WalkCall<D>, WalkCall<S>] {
  if (readTree === undefined) return [readdir, stat]
  const roots = new Map<string, [Map<string, FileStat>, Map<string, string[]>]>()
  const asked = new Set<string>()
  const covering = (virtual: string): [string, string] | null => {
    for (const root of roots.keys()) {
      if (virtual === root) return [root, '']
      const base = root.replace(/\/+$/, '') + '/'
      if (virtual.startsWith(base)) return [root, virtual.slice(base.length)]
    }
    return null
  }
  const treeReaddir: WalkCall<D> = async (path, index, nofollow) => {
    const virtual = path.virtual.replace(/\/+$/, '') || '/'
    let hit = answerable(path) ? covering(virtual) : null
    if (hit === null && !asked.has(virtual) && path.pattern === null) {
      asked.add(virtual)
      let found: Map<string, FileStat> | null
      try {
        found = await readTree(path)
      } catch (err) {
        if ((err as Partial<WalkDeclinedError>).declined !== true) throw err
        found = null
      }
      if (found !== null) {
        const copy = new Map(found)
        roots.set(virtual, [copy, listings(copy)])
        hit = [virtual, '']
      }
    }
    if (hit !== null) {
      const [root, rel] = hit
      const listing = roots.get(root)?.[1].get(rel)
      if (listing !== undefined) {
        answered?.add(virtual)
        const base = root.replace(/\/+$/, '') + '/'
        return listing.map((name) => base + name) as D
      }
    }
    return readdir(path, index, nofollow)
  }
  const treeStat: WalkCall<S> = async (path, index) => {
    const virtual = path.virtual.replace(/\/+$/, '') || '/'
    const hit = answerable(path) ? covering(virtual) : null
    if (hit !== null && hit[1] !== '') {
      const found = roots.get(hit[0])?.[0].get(hit[1])
      if (found !== undefined) return found as S
    }
    return stat(path, index)
  }
  return [treeReaddir, treeStat]
}
