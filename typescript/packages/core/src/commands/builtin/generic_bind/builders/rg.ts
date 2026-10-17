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

import { searchReads } from '../search.ts'
import { treeWalk } from '../../utils/tree.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'

import { rgGeneric } from '../../generic/rg.ts'
import { type GenericCommand, resolveGlobOf, type GenericCommandFn } from '../adapter.ts'

const rg: GenericCommandFn = async (ops, accessor, paths, texts, ctx) => {
  const idx = ctx.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
  const { readTree } = ops
  const readdir = (p: PathSpec): Promise<string[]> => ops.readdir(accessor, p, idx)
  const stat = (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, idx)
  return rgGeneric(
    resolved,
    texts,
    ctx,
    stat,
    readdir,
    await searchReads(ops, 'rg', accessor, resolved, texts, ctx),
    treeWalk<string[], FileStat>(
      readTree === undefined ? undefined : (p) => readTree(accessor, p, idx),
      readdir,
      stat,
    ),
  )
}

export const BUILDER: GenericCommand = {
  name: 'rg',
  read: true,
  fn: rg,
}
