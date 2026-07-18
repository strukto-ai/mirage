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

import {
  command,
  duGeneric,
  resolveGlobOf,
  specOf,
  type CommandFnResult,
  type CommandOpts,
  type PathSpec,
} from '@struktoai/mirage-core'
import { HF_RESOURCES, type HfAccessor } from '../../../accessor/hf.ts'
import { du as hfDu, duAll as hfDuAll } from '../../../core/hf/du.ts'
import { HF_IO } from './io.ts'

const resolveGlob = resolveGlobOf(HF_IO)

async function duCommand(
  accessor: HfAccessor,
  paths: PathSpec[],
  _texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  return duGeneric(
    resolved,
    opts,
    (p) => hfDu(accessor, p),
    (p) => hfDuAll(accessor, p),
  )
}

export const HF_DU = command({
  name: 'du',
  resource: [...HF_RESOURCES],
  spec: specOf('du'),
  fn: duCommand,
})
