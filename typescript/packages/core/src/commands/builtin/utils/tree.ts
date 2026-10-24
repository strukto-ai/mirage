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

import { classify } from '../../../errors/classify.ts'
import { isEnotdir, isFsError } from '../../../errors/fs.ts'
import type { FsCondition, WalkDeclinedError } from '../../../errors/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import type { MountView } from '../../../view/types.ts'
import { WalkLimitError, UsageError } from '../../errors.ts'

// The conditions under which a guard's path reaches no directory to walk.
const NO_DIRECTORY: ReadonlySet<FsCondition> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

export type ReadTree = (path: PathSpec) => Promise<Map<string, FileStat> | null>

export type WalkCall<R> = (path: PathSpec, nofollow?: boolean) => Promise<R>

/**
 * Let the mount that owns `path` refuse a command about to read every file
 * under it. The mount is asked at the resolved path: the command already
 * judged the spelling it was typed in, and reports a path that reaches no
 * directory (missing, not one, a link loop) itself. The mount refuses by
 * rejecting, which becomes the command's own error, `command: message` and
 * exit 1, on one mount or across several; any other filesystem error stays
 * one. Mirrors Python's `before_full_walk`.
 */
export async function beforeFullWalk(
  dispatch: DispatchFn | undefined,
  path: PathSpec,
  command: string,
): Promise<void> {
  if (dispatch === undefined) return
  try {
    await dispatch('before_full_walk', PathSpec.fromStrPath(path.virtual))
  } catch (err) {
    const condition = classify(err)
    if (condition !== null && NO_DIRECTORY.has(condition)) {
      console.debug(`walk guard at ${path.virtual}: ${String(err)}`)
      return
    }
    if (err instanceof UsageError || isFsError(err) || !(err instanceof Error)) throw err
    throw new UsageError(`${command}: ${err.message}`, 1)
  }
}

/**
 * The entries one walk of an operand may still list.
 *
 * A walk lists at most `walkLimit` entries of each mount it crosses: an
 * entry is charged to the mount serving the directory that lists it, counted
 * under the operand, or under the mount's root where that mount starts below
 * the operand. Once a count runs out the walk lists nothing more there, and
 * `stopped` holds what the command says about it, one line per folder,
 * without the command's name, in the order the walk met them. Mirrors
 * Python's `WalkBudget`.
 */
export class WalkBudget {
  readonly spent = new Map<string, number>()
  readonly stopped: string[] = []

  constructor(
    readonly operand: PathSpec,
    readonly mounts: MountView | null,
  ) {}

  private limitAt(directory: string): number {
    return this.mounts?.walkLimit?.(directory) ?? -1
  }

  private folderOf(directory: string): string {
    const top = this.operand.virtual.replace(/\/+$/, '')
    const root = (this.mounts?.rootOf(directory) ?? '/').replace(/\/+$/, '')
    if (root.startsWith(`${top}/`)) return root
    return top === '' ? '/' : top
  }

  private stop(folder: string, limit: number): void {
    const top = this.operand.virtual.replace(/\/+$/, '') || '/'
    const at = folder === top ? this.operand : PathSpec.fromStrPath(folder)
    const line = new WalkLimitError(at, limit).message
    if (!this.stopped.includes(line)) this.stopped.push(line)
  }

  /**
   * Charge one entry `directory` lists, or the one file a search reads when
   * `directory` is that file: true if the walk may keep it, false once its
   * folder's count is out, which records the stop.
   */
  spend(directory: string): boolean {
    const limit = this.limitAt(directory)
    if (limit < 0) return true
    const folder = this.folderOf(directory)
    const used = this.spent.get(folder) ?? 0
    if (used < limit) {
      this.spent.set(folder, used + 1)
      return true
    }
    this.stop(folder, limit)
    return false
  }

  /**
   * Whether the walk may still list `directory`; a folder whose count is out
   * records the stop and is not listed at all.
   */
  opens(directory: string): boolean {
    const limit = this.limitAt(directory)
    if (limit < 0) return true
    const folder = this.folderOf(directory)
    if ((this.spent.get(folder) ?? 0) < limit) return true
    this.stop(folder, limit)
    return false
  }

  /** `readdir` of `directory`, cut to what the walk may still list. */
  async listing(
    readdir: (path: PathSpec) => Promise<string[]>,
    directory: PathSpec,
  ): Promise<string[]> {
    if (!this.opens(directory.virtual)) return []
    return (await readdir(directory)).filter(() => this.spend(directory.virtual))
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
 * Whether an earlier answer may stand for `path`. A spelling with dots or a
 * trailing slash (`dotted`) or one the walk refused (`walkError`) goes to the
 * call, so the dispatcher checks it. Mirrors Python's `_answerable`.
 */
function answerable(path: PathSpec): boolean {
  return path.dotted === null && path.walkError === null
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
 * answers without the hidden entries. A subtree read stops at a link
 * (ENOTDIR), so a directory a walk reached through one is opened by
 * `readdir`, which follows it as opendir(3) does and meets whatever refuses
 * the directory it leads to. Both take the path first and pass the rest
 * through. Mirrors Python's `tree_walk`.
 */
export function treeWalk<D, S>(
  readTree: ReadTree | undefined,
  readdir: WalkCall<D>,
  stat: WalkCall<S>,
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
  const treeReaddir: WalkCall<D> = async (path, nofollow) => {
    const virtual = path.virtual.replace(/\/+$/, '') || '/'
    let hit = answerable(path) ? covering(virtual) : null
    if (hit === null && !asked.has(virtual) && path.pattern === null) {
      asked.add(virtual)
      let found: Map<string, FileStat> | null
      try {
        found = await readTree(path)
      } catch (err) {
        if ((err as Partial<WalkDeclinedError>).declined !== true && !isEnotdir(err)) throw err
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
        const base = root.replace(/\/+$/, '') + '/'
        return listing.map((name) => base + name) as D
      }
    }
    return readdir(path, nofollow)
  }
  const treeStat: WalkCall<S> = async (path, nofollow) => {
    const virtual = path.virtual.replace(/\/+$/, '') || '/'
    const hit = answerable(path) ? covering(virtual) : null
    if (hit !== null && hit[1] !== '') {
      const found = roots.get(hit[0])?.[0].get(hit[1])
      if (found !== undefined) return found as S
    }
    return stat(path, nofollow)
  }
  return [treeReaddir, treeStat]
}
