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

import { pathRulesActive } from '../../../../context/session_context.ts'
import { isEacces, isMissingPath } from '../../../../utils/errors.ts'
import { mountKey, mountPrefixOf, rekey } from '../../../../utils/key_prefix.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import { IOResult } from '../../../../io/types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import {
  DEFAULT_MAX_DU_ENTRIES,
  type ComputeEntries,
  type ComputeSize,
  type DuEntries,
  runDu,
} from '../../generic/du.ts'
import { type Builder, type CommandIO, resolveGlobOf } from '../adapter.ts'
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
class WalkBudget {
  private remaining: number | null
  hit = false
  // Paths the walk was refused (a rule denied them below the operand), in
  // the order it met them; the generic reports them after the walks the
  // way GNU names an unreadable directory.
  readonly unreadable: string[] = []

  constructor(remaining: number | null) {
    this.remaining = remaining
  }

  /** Charge one entry; false once the cap is exhausted. */
  spend(): boolean {
    if (this.remaining === null) return true
    if (this.remaining <= 0) {
      this.hit = true
      return false
    }
    this.remaining -= 1
    return true
  }
}

/**
 * Account for an error the walk met at `path`, or rethrow it.
 *
 * Absence counts as zero, because an entry listed a moment ago can be
 * gone by the time the walk reaches it; `isMissingPath` is that set (a
 * stamped ENOENT, or a path outside every mount). A refusal counts as
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
  if (!isMissingPath(err)) throw err
}

async function duWalk(
  ops: CommandIO,
  accessor: Accessor,
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
  let children: string[]
  try {
    children = await ops.readdir(accessor, path, index)
  } catch (err) {
    accountForWalkError(err, path, budget)
    return 0
  }
  let total = 0
  for (const child of children) {
    if (!budget.spend()) break
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

async function walkEntries(
  ops: CommandIO,
  accessor: Accessor,
  index: IndexCacheStore | undefined,
  budget: WalkBudget,
  path: PathSpec,
): Promise<DuEntries> {
  const entries: [string, number][] = []
  const total = await duWalk(ops, accessor, index, path, budget, entries)
  entries.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [entries, total]
}

export const DU_BUILDER: Builder = {
  name: 'du',
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    // A native du sums the raw tree; under a path rule the walk is what
    // reports a directory the rule refuses to open, where GNU does.
    const native = pathRulesActive() ? undefined : ops.du
    const budget = new WalkBudget(ops.maxDuEntries ?? DEFAULT_MAX_DU_ENTRIES)
    const computeSize: ComputeSize =
      native === undefined
        ? (p) => duWalk(ops, accessor, idx, p, budget, null)
        : (p) => native.size(accessor, p, idx)
    const computeEntries: ComputeEntries =
      native === undefined
        ? (p) => walkEntries(ops, accessor, idx, budget, p)
        : (p) => native.entries(accessor, p, idx)

    const out = await runDu(
      paths,
      opts,
      (targets) => resolveGlobOf(ops)(accessor, targets, idx),
      (p) => ops.stat(accessor, p, idx),
      computeSize,
      computeEntries,
      () => budget.hit,
      () => budget.unreadable,
    )
    return [out.stdout, new IOResult({ stderr: out.stderr, exitCode: out.exitCode })]
  },
}
