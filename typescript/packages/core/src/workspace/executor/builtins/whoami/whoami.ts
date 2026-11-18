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
  ownAccount,
  sessionUid,
  type Identity,
} from '../../../../commands/builtin/utils/identity.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall } from '../types.ts'

/**
 * Print the name of the effective user, as whoami does: it never reads
 * `$USER`, and fails for a uid the user database lacks.
 */
export function handleWhoami(identity: Identity): RedirectResult {
  const account = ownAccount(identity)
  if (account === null) {
    const err = encodeText(`whoami: cannot find name for user ID ${String(sessionUid(identity))}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'whoami', exitCode: 1, stderr: err }),
    ]
  }
  const out = encodeText(`${account.name}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'whoami', exitCode: 0 })]
}

/** The `whoami` arm. */
export function whoamiBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return Promise.resolve(handleWhoami({ profile: call.context.session.profile ?? null }))
}
