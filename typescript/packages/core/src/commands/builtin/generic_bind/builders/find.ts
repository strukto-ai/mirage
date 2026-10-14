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

import { FlagView } from '../../../spec/flag_view.ts'
import { specOf } from '../../../spec/builtins.ts'
import { walkFind } from '../../../../core/generic/find.ts'
import { findGeneric } from '../../generic/find.ts'
import { treeWalk } from '../../utils/tree.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { CommandFnResult, CommandOpts, CommandIO } from '../../../config.ts'
import { type GenericCommand, resolveGlobOf } from '../adapter.ts'

export const BUILDER: GenericCommand = {
  name: 'find',
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    return findWalk(ops, accessor, resolved, texts, opts)
  },
}

/**
 * Walk readdir/stat for find. Each start point asks the mount's `readTree`
 * for its subtree first, down to the expression's `-maxdepth`, so the walk
 * costs one call where the mount can answer.
 */
export function findWalk<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  resolved: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  const flags = new FlagView(opts.flags, specOf('find'))
  const bounded = flags.asBool('xdev') || flags.asBool('mount')
  // The last of -H, -L and -P decides, as in GNU; only -L follows the links
  // the walk meets.
  const follow = flags.typedOrder('H', 'L', 'P').at(-1) === 'L'
  const loops: [string, string][] = []
  const mounts = opts.ns?.mounts
  const { readTree } = ops
  // The walk classifies entries through stat (see walkFind). A directory the guarded readdir
  // refuses, and an entry whose stat fails, are collected here and
  // reported by the generic per start point.
  const closed: string[] = []
  const unstatted = new Map<string, unknown>()
  return findGeneric(
    resolved,
    texts,
    opts,
    (root, options) => {
      // A walk -maxdepth bounds reads its own levels, not the whole tree.
      const whole = readTree !== undefined && (options.maxDepth ?? null) === null
      const [readdir, stat] = treeWalk<string[], FileStat>(
        whole ? (p) => readTree(accessor, p, idx) : undefined,
        (spec: PathSpec, i?: IndexCacheStore) => ops.readdir(accessor, spec, i),
        (spec: PathSpec, i?: IndexCacheStore) => ops.stat(accessor, spec, i),
      )
      return walkFind(
        root,
        {
          unreadable: closed,
          unstatted,
          readdir: async (spec, i) =>
            bounded &&
            mounts !== undefined &&
            mounts.rootOf(spec.virtual) !== mounts.rootOf(root.virtual)
              ? []
              : readdir(spec, i),
          // -mtime must see namespace times (touch results, observed
          // writes on mtime-less backends), same as ls.
          stat: async (spec, i) => {
            const st = await stat(spec, i)
            const overlay = opts.ns?.statOverlay
            return overlay !== undefined ? overlay(spec.virtual, st) : st
          },
          follow: follow ? (opts.ns?.links ?? null) : null,
          loops,
        },
        options,
        idx,
      )
    },
    undefined,
    undefined,
    () => closed.splice(0),
    () => {
      const failed = [...unstatted]
      unstatted.clear()
      return failed
    },
    (spec) => ops.stat(accessor, spec, idx),
    () => loops.splice(0),
  )
}
