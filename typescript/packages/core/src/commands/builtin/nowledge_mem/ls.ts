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

import type { NowledgeMemAccessor } from '../../../accessor/nowledge_mem.ts'
import {
  nowledgeMemPath,
  nowledgeMemReaddir,
  nowledgeMemStat,
} from '../../../core/nowledge_mem/client.ts'
import { ResourceName, type PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { lsGeneric } from '../generic/ls.ts'

async function lsCommand(
  accessor: NowledgeMemAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  return lsGeneric(
    paths,
    opts,
    (p) => nowledgeMemReaddir(accessor, nowledgeMemPath(p.original, p.prefix)),
    (p) => nowledgeMemStat(accessor, nowledgeMemPath(p.original, p.prefix)),
  )
}

export const NOWLEDGE_MEM_LS = command({
  name: 'ls',
  resource: ResourceName.NOWLEDGE_MEM,
  spec: specOf('ls'),
  fn: lsCommand,
})
