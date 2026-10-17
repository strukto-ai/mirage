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

import { lsGeneric } from '../../generic/ls.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { treeWalk } from '../../utils/tree.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'
import { type GenericCommand, resolveGlobOf, type GenericCommandFn } from '../adapter.ts'

const ls: GenericCommandFn = async (ops, accessor, paths, _texts, ctx) => {
  const idx = ctx.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
  // Only -R walks; a plain listing reads one directory.
  const recursive = new FlagView(ctx.flags, specOf('ls')).asBool('recursive')
  const { readTree } = ops
  const [readdir, stat] = treeWalk<string[], FileStat>(
    !recursive || readTree === undefined ? undefined : (p) => readTree(accessor, p, idx),
    (p: PathSpec, _index?: IndexCacheStore, nofollow?: boolean) =>
      ops.readdir(accessor, p, idx, nofollow),
    (p: PathSpec) => ops.stat(accessor, p, idx),
  )
  return lsGeneric(resolved, ctx, readdir, stat)
}

export const BUILDER: GenericCommand = {
  name: 'ls',
  fn: ls,
}
