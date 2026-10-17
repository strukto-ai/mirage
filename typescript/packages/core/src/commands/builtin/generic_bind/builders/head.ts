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

import { headerAggregate } from '../../aggregators.ts'
import { headGeneric } from '../../generic/head.ts'
import {
  type GenericCommand,
  boundUncached,
  dirAwareStat,
  resolveGlobOf,
  type GenericCommandFn,
} from '../adapter.ts'
import type { PathSpec } from '../../../../types.ts'

const head: GenericCommandFn = async (ops, accessor, paths, texts, ctx) => {
  const idx = ctx.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
  const firstLines = ops.firstLines
  return headGeneric(
    resolved,
    texts,
    ctx,
    dirAwareStat(ops, accessor, ctx),
    (p) => ops.readStream(accessor, p, idx),
    boundUncached(firstLines && ((p: PathSpec, n: number) => firstLines(accessor, p, n, idx))),
  )
}

export const BUILDER: GenericCommand = {
  name: 'head',
  read: true,
  passThrough: true,
  aggregate: headerAggregate,
  fn: head,
}
