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

import { isEacces, isEnotdir, isMissingPath } from '../../../../utils/errors.ts'
import { mountKey, mountPrefixOf, rekey } from '../../../../utils/key_prefix.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import {
  DEFAULT_MAX_DU_ENTRIES,
  type ComputeEntries,
  type ComputeSize,
  duGeneric,
} from '../../generic/du.ts'
import { type DuEntries } from '../../../../vfs/types.ts'
import type { MountView } from '../../../../ops/types.ts'
import { type Builder, type CommandIO, resolveGlobOf, type BuilderFn } from '../adapter.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

/**
 * Entry allowance shared by every operand of one `du` invocation.
 *
 * Backends with no native du op are walked one `readdir` at a time, which on an
 * API-backed tree is one request per directory. Slack, for instance, exposes a
 * directory per channel per day, so an unbounded walk of a real workspace is
 * tens of thousands of requests. The budget stops the walk and records that the
 * answer is partial.
 */
export class WalkBudget {
  private remaining: number | null
  // A walk with no cap of its own (the dispatcher's, which spans mounts)
  // defers to the mounts it crosses: each entry is charged to the mount
  // serving it, at that mount's own cap, so a disk tree below a capped root
  // is not cut short and a service below an uncapped one is not walked
  // without its bound.
  private readonly mounts: MountView | undefined
  private readonly spent = new Map<string, number>()
  hit = false
  // Paths the walk was refused (a rule denied them below the operand), in
  // the order it met them; the generic reports them after the walks the
  // way GNU names an unreadable directory.
  readonly unreadable: string[] = []
  // Every directory the walk met, the operand's own included, which is how
  // one no file points at (an empty one, or a refused one) still gets
  // GNU's row.
  readonly directories: string[] = []

  constructor(remaining: number | null, mounts?: MountView) {
    this.remaining = remaining
    this.mounts = mounts
  }

  /** Charge one entry named by the listing of directory `path` (so a mount
   * root is charged to its parent, as the parent's own walk would count it);
   * false once the cap is exhausted. */
  spend(path: string): boolean {
    if (this.remaining !== null) {
      if (this.remaining <= 0) {
        this.hit = true
        return false
      }
      this.remaining -= 1
      return true
    }
    const cap = this.mounts?.maxDuEntries?.(path) ?? null
    if (this.mounts === undefined || cap === null) return true
    const owner = this.mounts.rootOf(path)
    const used = this.spent.get(owner) ?? 0
    if (used >= cap) {
      this.hit = true
      return false
    }
    this.spent.set(owner, used + 1)
    return true
  }
}

/**
 * Account for an error the walk met at `path`, or rethrow it.
 *
 * Absence counts as zero, because an entry listed a moment ago can be
 * gone by the time the walk reaches it; `isMissingPath` is that set (a
 * stamped ENOENT, or a path outside every mount), with ENOTDIR for one
 * whose directory became a plain file meanwhile. A refusal counts as
 * zero too, but never silently: GNU `du` skips what it cannot read,
 * names it on stderr and exits 1, so the path is recorded here for the
 * generic to report. Everything else -- a 429, a 5xx, an aborted line --
 * says the walk never saw that subtree, and a confidently wrong size is
 * worse than an unknown one, so it surfaces instead of being summed as
 * nothing.
 *
 * Both of the walk's doors come through here, because a refused `stat` is
 * the same fact as a refused `readdir`: a rule denying a path outright
 * refuses before the walk ever learns the entry is a directory. Recording
 * only the `readdir` one left a refused subtree missing from the total
 * with du still exiting 0, which no caller can tell from a small tree.
 * The reported line is `cannot read directory` either way, which is the
 * wording GNU uses once it knows the entry is one; a refused *file* is
 * named by a noun that does not fit it, and being named loudly is still
 * the better half of that trade.
 */
function accountForWalkError(err: unknown, path: PathSpec, budget: WalkBudget): void {
  if (isEacces(err)) {
    budget.unreadable.push(path.virtual)
    return
  }
  if (!isMissingPath(err) && !isEnotdir(err)) throw err
}

async function duWalk<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
  path: PathSpec,
  budget: WalkBudget,
  entries: [string, number][] | null,
): Promise<number> {
  let info
  try {
    info = await ops.stat(accessor, path, index)
  } catch (err) {
    accountForWalkError(err, path, budget)
    return 0
  }
  if (info.type !== FileType.DIRECTORY) {
    const size = info.size ?? 0
    if (entries !== null) {
      const prefix = mountPrefixOf(path.virtual, path.vfsPath)
      entries.push([`/${mountKey(path.virtual, prefix)}`, size])
    }
    return size
  }
  budget.directories.push(path.virtual)
  let children: string[]
  try {
    children = await ops.readdir(accessor, path, index)
  } catch (err) {
    accountForWalkError(err, path, budget)
    return 0
  }
  let total = 0
  for (const child of children) {
    if (!budget.spend(path.virtual)) break
    total += await duWalk(
      ops,
      accessor,
      index,
      PathSpec.fromStrPath(child, rekey(path.virtual, path.vfsPath, child)),
      budget,
      entries,
    )
  }
  return total
}

export function walkSize<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
  budget: WalkBudget,
  path: PathSpec,
): Promise<number> {
  return duWalk(ops, accessor, index, path, budget, null)
}

export async function walkEntries<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
  budget: WalkBudget,
  path: PathSpec,
): Promise<DuEntries> {
  const entries: [string, number][] = []
  const total = await duWalk(ops, accessor, index, path, budget, entries)
  entries.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [entries, total]
}

const du: BuilderFn = async (ops, accessor, paths, _texts, opts) => {
  const idx = opts.index ?? undefined
  // Hides and path rules turn the native du off upstream (scopedIo),
  // so the walk is what reports a directory a rule refuses to open.
  const native = ops.du
  const budget = new WalkBudget(
    ops.maxDuEntries === undefined ? DEFAULT_MAX_DU_ENTRIES : ops.maxDuEntries,
    opts.ns?.mounts,
  )
  const computeSize: ComputeSize =
    native === undefined
      ? (p) => walkSize(ops, accessor, idx, budget, p)
      : (p) => native.size(accessor, p, idx)
  const computeEntries: ComputeEntries =
    native === undefined
      ? (p) => walkEntries(ops, accessor, idx, budget, p)
      : (p) => native.entries(accessor, p, idx)

  return duGeneric(
    paths,
    opts,
    (targets) => resolveGlobOf(ops)(accessor, targets, idx),
    (p) => ops.stat(accessor, p, idx),
    computeSize,
    computeEntries,
    () => budget.hit,
    () => budget.unreadable,
    () => budget.directories,
  )
}

export const BUILDER: Builder = {
  name: 'du',
  fn: du,
}
