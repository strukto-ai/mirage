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
import { landingRoot, linksOf, mountsOf } from '../../utils/links.ts'
import { WalkBudget, treeWalk } from '../../utils/tree.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { type GenericCommand } from '../adapter.ts'
import { type CommandFiles, commandFiles, resolveOrEmpty } from '../files.ts'

export const BUILDER: GenericCommand = {
  name: 'find',
  fn: async (_accessor, paths, texts, ctx) => {
    const files = commandFiles(ctx, paths)
    return findWalk(files, await resolveOrEmpty(files, paths), texts, ctx)
  },
}

/**
 * Walk readdir/stat for find. Each start point asks the mount's `readTree`
 * for its subtree first, down to the expression's `-maxdepth`, so the walk
 * costs one call where the mount can answer.
 */
export function findWalk(
  files: CommandFiles,
  resolved: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const flags = new FlagView(ctx.flags, specOf('find'))
  const bounded = flags.asBool('xdev') || flags.asBool('mount')
  // The last of -H, -L and -P decides, as in GNU; only -L follows the links
  // the walk meets.
  const follow = flags.typedOrder('H', 'L', 'P').at(-1) === 'L'
  const loops: [string, string][] = []
  const mounts = mountsOf(ctx)
  const links = linksOf(ctx) ?? null
  // The walk classifies entries through stat (see walkFind). A directory the guarded readdir
  // refuses, and an entry whose stat fails, are collected here and
  // reported by the generic per start point.
  const closed: string[] = []
  const unstatted = new Map<string, unknown>()
  const stopped: string[] = []
  return findGeneric(
    resolved,
    texts,
    ctx,
    async (root, options) => {
      // A walk -maxdepth bounds reads its own levels, not the whole tree.
      const whole = files.answers('read_tree') && (options.maxDepth ?? null) === null
      const [readdir, stat] = treeWalk<string[], FileStat>(
        whole ? files.readTree : undefined,
        (p) => files.readdir(p),
        files.stat,
      )
      const home = bounded && mounts !== undefined ? landingRoot(mounts, links, root.virtual) : null
      const budget = new WalkBudget(root, mounts ?? null)
      const keys = await walkFind(
        root,
        {
          unreadable: closed,
          unstatted,
          readdir,
          ...(home !== null && mounts !== undefined
            ? { enters: (virtual: string) => landingRoot(mounts, links, virtual) === home }
            : {}),
          stat,
          follow: follow ? links : null,
          loops,
          listing: (p) => budget.listing(readdir, p),
        },
        options,
      )
      stopped.push(...budget.stopped)
      return keys
    },
    undefined,
    undefined,
    () => closed.splice(0),
    () => {
      const failed = [...unstatted]
      unstatted.clear()
      return failed
    },
    files.stat,
    () => loops.splice(0),
    () => stopped.splice(0),
  )
}
