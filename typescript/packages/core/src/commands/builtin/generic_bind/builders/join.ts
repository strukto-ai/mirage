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

import { joinGeneric } from '../../generic/join.ts'
import { type Builder, resolveGlobOf, type BuilderFn } from '../adapter.ts'

const join: BuilderFn = async (ops, accessor, paths, _texts, opts) => {
  const idx = opts.index ?? undefined
  const resolveGlob = resolveGlobOf(ops)
  return joinGeneric(
    paths,
    opts,
    (targets) => resolveGlob(accessor, targets, idx),
    (p) => ops.readStream(accessor, p, idx),
  )
}

export const BUILDER: Builder = {
  name: 'join',
  read: true,
  fn: join,
}
