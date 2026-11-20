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

import { treeWalk } from '../../utils/tree.ts'
import type { FileStat, PathSpec } from '../../../../types.ts'

import { facts, fdGeneric } from '../../generic/fd.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

const fd: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const stat = (p: PathSpec): Promise<FileStat> => files.stat(p)
  const [levelReaddir, levelStat] = treeWalk<string[], FileStat>(
    files.readTree,
    files.readdir,
    stat,
    false,
    files.signal,
  )
  return fdGeneric(resolved, texts, ctx, levelStat, levelReaddir)
}

export const BUILDER: GenericCommand = {
  name: 'fd',
  facts: facts,
  fn: fd,
}
