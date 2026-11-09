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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { extraOperandError } from '../../spec/usage.ts'

const ENC = new TextEncoder()
const COUNT = ENC.encode('\n# users=0\n')
const HEADING = ENC.encode('NAME     LINE         TIME         COMMENT\n')

// Nobody logs in to a workspace and it has no boot record, so only -q and -H
// print anything.
function who(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const extra = texts[2]
  if (extra !== undefined) throw extraOperandError('who', extra)
  const fl = new FlagView(ctx.flags, specOf('who'))
  if (fl.asBool('count')) return [COUNT, new IOResult()]
  return [fl.asBool('heading') ? HEADING : null, new IOResult()]
}

export const GENERAL_WHO = command({ name: 'who', vfs: null, spec: specOf('who'), fn: who })
