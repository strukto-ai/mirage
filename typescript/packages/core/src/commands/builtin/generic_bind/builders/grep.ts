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

import { memoryRoom } from '../../../../io/memory.ts'
import { matchingTree, cappedReads, searchReads } from '../search.ts'
import { mountsOf } from '../../utils/links.ts'
import { treeWalk } from '../../utils/tree.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'

import { prefixAggregate } from '../../aggregators.ts'
import { facts, grepGeneric } from '../../generic/grep.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

const grep: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const matches = await matchingTree(files, resolved, texts, ctx)
  const room = memoryRoom()
  const [readdir, stat] =
    matches !== null
      ? ([(p: PathSpec) => Promise.resolve(matches.get(p.virtual) ?? []), files.stat] as const)
      : treeWalk<string[], FileStat>(
          files.readTree,
          (p) => files.readdir(p),
          files.stat,
          files.answers('read_tree'),
          files.signal,
          room !== null && room <= 32 * 1024 * 1024 ? 256 : undefined,
        )
  return grepGeneric(
    'grep',
    resolved,
    texts,
    ctx,
    stat,
    readdir,
    matches === null
      ? await searchReads(files, 'grep', resolved, texts, ctx)
      : cappedReads(files.read, resolved, mountsOf(ctx))[0],
  )
}

export const BUILDER: GenericCommand = {
  name: 'grep',
  facts: facts,
  read: true,
  givesBack: true,
  aggregate: prefixAggregate,
  fn: grep,
}
