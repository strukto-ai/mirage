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

import { isProgramInvocation, type RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { BIN_PREFIX } from '../../../../shell/constants.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { SessionState } from '../../../session/session.ts'
import { envSnapshot } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall } from '../types.ts'

/**
 * Print each named variable's exported value in order, or every exported
 * `NAME=value` sorted when none is named; `-0` / `--null` ends each with a
 * NUL instead of a newline. A name with no exported value prints nothing
 * and fails the command with 1 once the others printed. Run by the shell,
 * its environment holds `_` as the program's path, last, as bash hands every
 * program it runs; run by `env`, the `_` env handed on.
 */
export function handlePrintenv(args: readonly string[], session: SessionState): RedirectResult {
  // The process view, not the shell view: GNU printenv is a separate
  // binary, so the only names it can possibly see are the exported ones.
  // A plain `X=hello` is invisible to it and exits 1.
  const env = envSnapshot(session)
  if (!isProgramInvocation(session)) {
    delete env._
    env._ = `${BIN_PREFIX}/printenv`
  }
  let end = '\n'
  const names: string[] = []
  for (const [i, arg] of args.entries()) {
    if (arg === '--') {
      names.push(...args.slice(i + 1))
      break
    }
    if (arg === '-0' || arg === '--null') end = '\0'
    else names.push(arg)
  }
  if (names.length === 0) {
    const last = env._
    delete env._
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`)
    lines.sort(compareCodePoints)
    if (last !== undefined) lines.push(`_=${last}`)
    const out = encodeText(lines.map((line) => line + end).join(''))
    return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
  }
  const values = names.flatMap((name) => (env[name] === undefined ? [] : [env[name]]))
  const exitCode = values.length === names.length ? 0 : 1
  const out = values.map((value) => value + end).join('')
  return [
    out === '' ? null : encodeText(out),
    new IOResult({ exitCode }),
    new ExecutionNode({ command: 'printenv', exitCode }),
  ]
}

/** The `printenv` arm. */
export function printenvBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return Promise.resolve(handlePrintenv(call.argv.args, call.context.session))
}
