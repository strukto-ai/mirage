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

import { fsStrerror, isEacces, isEnotdir, isFsError, isMissingPath } from '../../../../errors/fs.ts'
import { mountKey, mountPrefixOf, rekey, underPath } from '../../../../utils/key_prefix.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import { type FileStat, FileType, PathSpec } from '../../../../types.ts'
import { treeWalk, type WalkCall } from '../../utils/tree.ts'
import { type ComputeEntries, type ComputeSize, duGeneric } from '../../generic/du.ts'
import { DEFAULT_MAX_DU_ENTRIES } from '../../../../vfs/constants.ts'
import { type DuEntries } from '../../../../vfs/types.ts'
import type { LinkView, MountView } from '../../../../view/types.ts'
import { type GenericCommand, resolveGlobOf, type GenericCommandFn } from '../adapter.ts'
import type { CommandIO } from '../../../config.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'

/**
 * Entry allowance shared by every operand of one `du` invocation.
 *
 * A walk the mount's `readTree` does not answer takes one `readdir` per
 * directory, which on an API-backed tree is one request per directory. Slack, for instance, exposes a
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
  // Every directory the last walk met, the operand's own included, which is
  // how one no file points at (an empty one, or a refused one) still gets
  // GNU's row. Each walk starts it afresh, so an operand's rows are its own
  // walk's.
  readonly directories: string[] = []
  // Under -L, each link that leads nowhere, with the strerror GNU adds for
  // a chain that loops.
  readonly inaccessible: [string, string | null][] = []

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
 * Both of the walk's calls come through here, because a refused `stat` is
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

// The walk's readdir and stat, answered from the mount's `readTree` where it
// can, and the directories listed that way, which cost no request and so no
// budget. Mirrors Python's `_walk`.
interface Walk {
  readdir: WalkCall<string[]>
  stat: WalkCall<FileStat>
  answered: Set<string>
}

function treeOf<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
): Walk {
  const answered = new Set<string>()
  const { readTree } = ops
  const [readdir, stat] = treeWalk<string[], FileStat>(
    readTree === undefined ? undefined : (p) => readTree(accessor, p, index),
    (p: PathSpec, i?: IndexCacheStore) => ops.readdir(accessor, p, i),
    (p: PathSpec, i?: IndexCacheStore) => ops.stat(accessor, p, i),
    answered,
  )
  return { readdir, stat, answered }
}

/**
 * What `du -L` follows links by, for one invocation.
 *
 * GNU counts each file once, under the first name its walks meet, across
 * every operand of the line (du.c's di_set, coreutils 9.7): what one operand
 * reaches is not counted again under another, and an operand already counted
 * prints nothing. A link leading back into its operand's own tree waits for
 * the walk to end, and counts only if the walk never reached the file under
 * the file's own name: mirage's sorted walk prefers that name (where GNU's
 * readdir order may reach the link first), and a directory the walk may not
 * list leaves the link the one name that reaches the file, which GNU then
 * counts it under. Under `-x` a link that leads onto another mount is left out
 * whole, as GNU leaves out what stat(2) places on another device.
 */
class Dereference {
  constructor(
    readonly links: LinkView,
    // The mount boundaries `-x` keeps the walks within, null without `-x`.
    readonly mounts: MountView | null,
    // What the walks counted so far, each as the path it resolves to.
    readonly counted = new Set<string>(),
    // The operand being walked, as the path it resolves to.
    readonly tree = '/',
    // Under `-x`, the mount that operand lies on.
    readonly home: string | null = null,
    // The walk's links into its tree, each with the path it resolves to.
    readonly waiting: [PathSpec, string][] = [],
  ) {}

  /** This invocation's state, walking one operand. */
  operand(path: PathSpec): Dereference {
    const tree = this.links.resolve(path.virtual)
    const home = this.mounts === null ? null : this.mounts.rootOf(tree)
    return new Dereference(this.links, this.mounts, this.counted, tree, home)
  }

  /** The same walk, settling a link into its tree under the link's name. */
  under(link: PathSpec): Dereference {
    return new Dereference(
      this.links,
      this.mounts,
      this.counted,
      link.virtual,
      this.home,
      this.waiting,
    )
  }

  /** Whether an earlier operand's walk already counted this one. */
  repeated(path: PathSpec): boolean {
    return this.counted.has(this.links.resolve(path.virtual))
  }
}

/**
 * What `du -L` counts an entry as, null when it counts nothing. `info` is the
 * entry's own stat, a link's row for a link; a link it cannot follow is
 * recorded on `budget`.
 */
async function counted(
  follow: Dereference,
  path: PathSpec,
  info: FileStat,
  budget: WalkBudget,
): Promise<FileStat | null> {
  let real: string
  let target: FileStat | null
  try {
    real = follow.links.resolve(path.virtual)
    target = info.type === FileType.SYMLINK ? await follow.links.targetStat(path.virtual) : info
  } catch (err) {
    if (!isFsError(err)) throw err
    budget.inaccessible.push([path.virtual, fsStrerror(err)])
    return null
  }
  if (target === null) {
    budget.inaccessible.push([path.virtual, null])
    return null
  }
  if (follow.home !== null && follow.mounts?.rootOf(real) !== follow.home) return null
  if (info.type === FileType.SYMLINK && underPath(real, follow.tree)) {
    follow.waiting.push([path, real])
    return null
  }
  if (follow.counted.has(real)) return null
  follow.counted.add(real)
  return target
}

async function duWalk(
  walk: Walk,
  index: IndexCacheStore | undefined,
  path: PathSpec,
  budget: WalkBudget,
  entries: [string, number][] | null,
  follow: Dereference | null,
): Promise<number> {
  let info
  try {
    info = await walk.stat(path, index)
  } catch (err) {
    accountForWalkError(err, path, budget)
    return 0
  }
  if (follow !== null) {
    const row = await counted(follow, path, info, budget)
    if (row === null) return 0
    info = row
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
    children = await walk.readdir(path, index)
  } catch (err) {
    accountForWalkError(err, path, budget)
    return 0
  }
  let total = 0
  const free = walk.answered.has(path.virtual.replace(/\/+$/, '') || '/')
  for (const child of children) {
    if (!free && !budget.spend(path.virtual)) break
    total += await duWalk(
      walk,
      index,
      PathSpec.fromStrPath(child, rekey(path.virtual, path.vfsPath, child)),
      budget,
      entries,
      follow,
    )
  }
  return total
}

/**
 * Walk one operand, then count each link into its tree whose file the walk
 * never reached under the file's own name. `entries` collects each file's
 * size under its name, null for a total alone. Mirrors Python's
 * _walk_operand.
 */
async function walkOperand<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
  budget: WalkBudget,
  follow: Dereference | null,
  path: PathSpec,
  entries: [string, number][] | null,
): Promise<number> {
  budget.directories.length = 0
  const walk = treeOf(ops, accessor, index)
  const state = follow === null ? null : follow.operand(path)
  let total = await duWalk(walk, index, path, budget, entries, state)
  if (state !== null) {
    for (const [link, real] of state.waiting) {
      if (!state.counted.has(real)) {
        total += await duWalk(walk, index, link, budget, entries, state.under(link))
      }
    }
  }
  return total
}

export function walkSize<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
  budget: WalkBudget,
  follow: Dereference | null,
  path: PathSpec,
): Promise<number> {
  return walkOperand(ops, accessor, index, budget, follow, path, null)
}

export async function walkEntries<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index: IndexCacheStore | undefined,
  budget: WalkBudget,
  follow: Dereference | null,
  path: PathSpec,
): Promise<DuEntries> {
  const entries: [string, number][] = []
  const total = await walkOperand(ops, accessor, index, budget, follow, path, entries)
  entries.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [entries, total]
}

const du: GenericCommandFn = async (ops, accessor, paths, _texts, opts) => {
  const idx = opts.index ?? undefined
  const budget = new WalkBudget(
    ops.maxDuEntries === undefined ? DEFAULT_MAX_DU_ENTRIES : ops.maxDuEntries,
    opts.ns?.mounts,
  )
  const flags = new FlagView(opts.flags, specOf('du'))
  const links = opts.ns?.links
  const follow =
    links !== undefined && flags.typedOrder('L', 'P').at(-1) === 'L'
      ? new Dereference(links, flags.asBool('one_file_system') ? (opts.ns?.mounts ?? null) : null)
      : null
  const computeSize: ComputeSize = (p) => walkSize(ops, accessor, idx, budget, follow, p)
  const computeEntries: ComputeEntries = (p) => walkEntries(ops, accessor, idx, budget, follow, p)

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
    () => budget.inaccessible,
    follow === null ? undefined : (p) => follow.repeated(p),
  )
}

export const BUILDER: GenericCommand = {
  name: 'du',
  fn: du,
}
