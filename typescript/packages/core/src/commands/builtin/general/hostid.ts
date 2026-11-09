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
import { extraOperandError } from '../../spec/usage.ts'

const HOST_ID = new TextEncoder().encode('00000000\n')

// Fixed, as uname is, so no host detail leaks.
function hostid(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): CommandFnResult {
  const extra = texts[0]
  if (extra !== undefined) throw extraOperandError('hostid', extra)
  return [HOST_ID, new IOResult()]
}

export const GENERAL_HOSTID = command({
  name: 'hostid',
  vfs: null,
  spec: specOf('hostid'),
  fn: hostid,
})
