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

import { teeGeneric } from '../../generic/tee.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

const tee: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  // A backend that can append natively does; the rest fall back to the
  // read-modify-write inside the generic.
  return teeGeneric(
    resolved,
    texts,
    ctx,
    files.readStream,
    (p, d) => files.write(p, d),
    files.answers('append') ? files.append : undefined,
    files.stat,
  )
}

export const BUILDER: GenericCommand = {
  name: 'tee',
  write: true,
  fn: tee,
}
