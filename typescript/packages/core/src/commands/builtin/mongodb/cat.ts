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

import type { MongoDBAccessor } from '../../../accessor/mongodb.ts'
import type { PathSpec } from '../../../types.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { catGeneric } from '../generic/cat.ts'
import type { Builder, CommandIO } from '../generic_bind/adapter.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'

async function cat(
  ops: CommandIO<MongoDBAccessor>,
  accessor: MongoDBAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, opts.index ?? undefined) : []
  return catGeneric(
    resolved,
    texts,
    opts,
    (p) => ops.stat(accessor, p, opts.index ?? undefined),
    (p) => ops.readStream(accessor, p, opts.index ?? undefined),
  )
}

export const BUILDER: Builder<MongoDBAccessor> = {
  name: 'cat',
  read: true,
  fn: cat,
}
