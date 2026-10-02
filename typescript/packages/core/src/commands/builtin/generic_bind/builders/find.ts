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

import { hiddenPathsIntersect, pathRulesActive } from '../../../../context/session_context.ts'
import { walkFind } from '../../../../core/generic/find.ts'
import { findGeneric } from '../../generic/find.ts'
import type { PathSpec } from '../../../../types.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { CommandFnResult, CommandOpts } from '../../../config.ts'
import { type Builder, type CommandIO, overlaidStat, resolveGlobOf } from '../adapter.ts'

export const FIND_BUILDER: Builder = {
  name: 'find',
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const { find } = ops
    // Whether a directory start point holds nothing, for `-empty`. Asked
    // once, for the start point, and only when the expression mentions it.
    const dirEmpty = async (spec: PathSpec): Promise<boolean> =>
      (await ops.readdir(accessor, spec, idx)).length === 0
    // A native find op classifies on the raw backend tree, so under
    // hidden paths its predicates would answer for entries the session
    // cannot see (-empty omits a visible directory whose only child is
    // hidden, which also reveals that the child exists), and under a
    // path rule it would list a directory the rule refuses to open. The
    // walk classifies through the guarded readdir/stat, so it sees
    // exactly the visible tree and reports the refusal where GNU does;
    // same trade du makes for its summarize fast path. Per operand, not
    // per session: a hidden .env under /repo must not force find on /s3
    // off its native op.
    if (
      find !== undefined &&
      !pathRulesActive() &&
      !resolved.some((p) => hiddenPathsIntersect(p.virtual))
    ) {
      // Time tests must see namespace times (touch results, observed
      // writes), so a local backend, or a remote one whose operand holds
      // overlay times, post-filters through the overlay-aware stat
      // instead of pushing the window into the backend's find, which
      // judges by its own times. A remote operand with no overlay times
      // keeps the push-down and its one-request listing.
      const timesUnder = opts.ns?.timesUnder
      const stat =
        ops.local === true ||
        (timesUnder !== undefined && resolved.some((p) => timesUnder(p.virtual)))
          ? overlaidStat((spec) => ops.stat(accessor, spec, idx), opts.ns?.statOverlay)
          : undefined
      return findGeneric(
        resolved,
        texts,
        opts,
        (root, options) => find(accessor, root, options, idx),
        stat,
        dirEmpty,
      )
    }
    return findWalk(ops, accessor, resolved, texts, opts)
  },
}

/**
 * Walk readdir/stat for find, the fork taken when no native find op may
 * answer: no backend op, hidden paths or a path rule in force, or (github)
 * a truncated tree that names only some paths.
 */
export function findWalk<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  resolved: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const idx = opts.index ?? undefined
  // The walk classifies entries through stat (see walkFind). A directory the guarded readdir
  // refuses, and an entry whose stat fails, are collected here and
  // reported by the generic per start point.
  const closed: string[] = []
  const unstatted = new Map<string, unknown>()
  return findGeneric(
    resolved,
    texts,
    opts,
    (root, options) =>
      walkFind(
        root,
        {
          unreadable: closed,
          unstatted,
          readdir: (spec, i) => ops.readdir(accessor, spec, i),
          // -mtime must see namespace times (touch results, observed
          // writes on mtime-less backends), same as ls.
          stat: async (spec, i) => {
            const st = await ops.stat(accessor, spec, i)
            const overlay = opts.ns?.statOverlay
            return overlay !== undefined ? overlay(spec.virtual, st) : st
          },
          // A namespace symlink is an entry `-empty` must count and no
          // backend readdir can see.
          links: opts.ns?.links ?? null,
        },
        options,
        idx,
      ),
    undefined,
    undefined,
    () => closed.splice(0),
    () => {
      const failed = [...unstatted]
      unstatted.clear()
      return failed
    },
    (spec) => ops.stat(accessor, spec, idx),
  )
}
