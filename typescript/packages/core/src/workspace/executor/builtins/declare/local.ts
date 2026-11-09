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

import type { RedirectResult } from '../../../../context/session_context.ts'
import { prefixTemporaries } from '../../../session/state.ts'
import type { BuiltinCall } from '../types.ts'
import { declared } from './declare.ts'

/**
 * The `local` arm, for a name the parser did not read as a declaration: its
 * words are the operands, an element's subscript as typed. Mirrors Python's
 * local_builtin.
 */
export function localBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  const args = [...call.argv.args]
  const temporaries = prefixTemporaries(call.context.session)
  return declared(
    'local',
    (shell) => shell.declare('local', '', '', args, temporaries, false),
    call.context,
    call.executeFn,
    call.callStack,
  )
}
