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
import type { SessionState } from '../../../session/session.ts'
import { envSnapshot } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { BuiltinCall, Result } from '../types.ts'

export function handlePrintenv(name: string | null, session: SessionState): Result {
  // The process view, not the shell view: GNU printenv is a separate
  // binary, so the only names it can possibly see are the exported ones.
  // A plain `X=hello` is invisible to it and exits 1.
  const env = envSnapshot(session)
  if (name !== null) {
    const val = env[name]
    if (val === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1 }),
        new ExecutionNode({ command: 'printenv', exitCode: 1 }),
      ]
    }
    const out = new TextEncoder().encode(`${val}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
  }
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`)
  lines.sort(compareCodePoints)
  const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
}

/** The `printenv` arm. */
export function printenvBuiltin(call: BuiltinCall): Promise<Result> {
  const args = call.argv.args
  return Promise.resolve(handlePrintenv(args.length > 0 ? (args[0] ?? null) : null, call.session))
}
