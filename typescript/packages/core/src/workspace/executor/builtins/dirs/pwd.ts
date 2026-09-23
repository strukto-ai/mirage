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
import { logicalCwd } from '../../../session/shell_dirs.ts'
import { ExecutionNode } from '../../../types.ts'
import { PWD_OPTIONS, PWD_USAGE } from './constants.ts'
import { type DirArgs, splitModeOptions } from './dirs.ts'
import type { BuiltinCall, Result } from '../types.ts'

// Print the working directory, logical by default and physical under -P
// (or `set -P`). GNU ignores every operand: `pwd extra` still prints the
// cwd.
export function handlePwd(operands: DirArgs, session: SessionState): Result {
  const shellPhysical = session.shellOptions.physical === true
  const { bad, physical } = splitModeOptions(operands, PWD_OPTIONS, shellPhysical)
  if (bad !== null) {
    const err = new TextEncoder().encode(`pwd: -${bad}: invalid option\n${PWD_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'pwd', exitCode: 2, stderr: err }),
    ]
  }
  const cwd = physical ? session.cwd : logicalCwd(session)
  const out = new TextEncoder().encode(`${cwd}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'pwd', exitCode: 0 })]
}

/** The `pwd` arm. */
export function pwdBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handlePwd([...call.argv.operands], call.session))
}
