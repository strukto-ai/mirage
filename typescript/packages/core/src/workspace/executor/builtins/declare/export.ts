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
import { VarAttr } from '../../../../shell/variable.ts'
import type { BuiltinCall } from '../types.ts'
import { markNames } from './declare.ts'

/** The `export` arm. */
export function exportBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return markNames(
    [...call.argv.args],
    call.context,
    call.executeFn,
    call.callStack,
    VarAttr.Export,
    call.parser,
  )
}
