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

import { IOResult } from '../../../../io/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

export function handleWhoami(namespace: Namespace): Result {
  // GNU whoami reports the effective user and never consults $USER; the
  // workspace user (launch agentId, shared via the namespace store) is
  // the effective identity here. With no claimed identity it fails like
  // GNU does for a uid with no passwd entry.
  if (namespace.user === null) {
    const err = encodeText('whoami: cannot find name for user ID\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'whoami', exitCode: 1, stderr: err }),
    ]
  }
  const out = encodeText(`${namespace.user}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'whoami', exitCode: 0 })]
}

/** The `whoami` arm. */
export function whoamiBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleWhoami(call.namespace))
}
