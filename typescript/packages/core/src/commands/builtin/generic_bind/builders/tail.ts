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
import { parseFlags, tailGeneric } from '../../generic/tail.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, dirAwareStat, dirAwareStream, fileSize, resolveOrEmpty } from '../files.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'

const tail: CommandFn = async (_accessor, paths, texts, ctx) => {
  const parsed = parseFlags(ctx.flags)
  if (parsed instanceof IOResult) return [null, parsed]
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const backendStat = dirAwareStat(files, ctx)
  const readSize = fileSize(files, ctx, true)
  async function stat(path: PathSpec): Promise<FileStat> {
    const row = await backendStat(path)
    return row.with({ size: await readSize(path) })
  }
  return tailGeneric(
    parsed,
    resolved,
    texts,
    ctx,
    dirAwareStream(files, ctx),
    stat,
    files.answers('read_range') ? files.read : null,
    files.answers('last_lines') ? files.lastLines : undefined,
    files.answers('follow') ? files.follow : undefined,
  )
}

export const BUILDER: GenericCommand = {
  name: 'tail',
  read: true,
  aggregate: headerAggregate,
  fn: tail,
}
