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

import { md5sumGeneric } from '../../generic/md5sum.ts'
import {
  type GenericCommand,
  boundUncached,
  dirAwareStat,
  dirAwareStream,
  resolveGlobOf,
  type GenericCommandFn,
} from '../adapter.ts'
import type { PathSpec } from '../../../../types.ts'

const md5sum: GenericCommandFn = async (ops, accessor, paths, _texts, ctx) => {
  const idx = ctx.index ?? undefined
  const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
  const { checksum } = ops
  return md5sumGeneric(
    resolved,
    ctx,
    dirAwareStream(ops, accessor, ctx),
    dirAwareStat(ops, accessor, ctx),
    boundUncached(checksum && ((p: PathSpec, a: string) => checksum(accessor, p, a, idx))),
  )
}

export const BUILDER: GenericCommand = {
  name: 'md5sum',
  read: true,
  fn: md5sum,
}
