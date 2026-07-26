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
  duGeneric,
  duHasContent,
  duOperands,
  parseDuFlags,
} from '../../generic/du.ts'
import { type Builder, type CommandIO, resolveGlobOf } from '../adapter.ts'

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
  } catch {
    return 0
  }
  if (info.type !== FileType.DIRECTORY) {
    const size = info.size ?? 0
    if (entries !== null) {
      const prefix = mountPrefixOf(path.virtual, path.resourcePath)
      entries.push([`/${mountKey(path.virtual, prefix)}`, size])
    }
    return size
  }
  let children: string[]
  try {
    children = await ops.readdir(accessor, path, index)
  } catch {
    return 0
  }
  let total = 0
  for (const child of children) {
    if (!budget.spend()) break
    total += await duWalk(
      ops,
      accessor,
      index,
      PathSpec.fromStrPath(child, rekey(path.virtual, path.resourcePath, child)),
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
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return [entries, total]
}

export const DU_BUILDER: Builder = {
  name: 'du',
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const { duSize, duEntries } = ops
    // GNU rejects a bad option combination before it stats anything.
    const flags = parseDuFlags(opts)
    const budget = new WalkBudget(ops.maxDuEntries ?? DEFAULT_MAX_DU_ENTRIES)
    const computeSize: ComputeSize =
      duSize === undefined
        ? (p) => duWalk(ops, accessor, idx, p, budget, null)
        : (p) => duSize(accessor, p, idx)
    const computeEntries: ComputeEntries | undefined =
      duSize === undefined
        ? (p) => walkEntries(ops, accessor, idx, budget, p)
        : duEntries === undefined
          ? undefined
          : (p) => duEntries(accessor, p, idx)

    const { present, missing } = await duOperands(
      paths,
      opts.cwd,
      (targets) => resolveGlobOf(ops)(accessor, targets, idx),
      (p) => ops.stat(accessor, p, idx),
      (p) => duHasContent(computeSize, computeEntries, p),
    )
    const out = await duGeneric(
      present,
      flags,
      computeSize,
      computeEntries,
      missing,
      () => budget.hit,
    )
    return [out.stdout, new IOResult({ stderr: out.stderr, exitCode: out.exitCode })]
  },
}
