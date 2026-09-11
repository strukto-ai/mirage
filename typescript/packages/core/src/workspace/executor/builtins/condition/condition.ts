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
import { ExitSignal } from '../../../../shell/errors.ts'
import type { PathSpec } from '../../../../types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { evalFlat } from './flat.ts'
import { evalCond } from './tree.ts'
import { CondError } from './types.ts'
import type { CondContext, CondNode } from './types.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { ShellBuiltin as SB } from '../../../../shell/types.ts'
import { wordText } from '../../../../types.ts'
import { sessionView } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'

/**
 * Evaluate test/[ (flat argv) or [[ (condition tree). `name` is the
 * invocation spelling used in diagnostics: "test", "[", or "[[".
 */
export async function handleTest(
  dispatch: DispatchFn,
  namespace: Namespace,
  args: (string | PathSpec)[] | CondNode,
  session: Session,
  name = 'test',
  view?: SessionView,
): Promise<Result> {
  const ctx: CondContext = {
    dispatch,
    namespace,
    session,
    name,
    ...(view !== undefined ? { view } : {}),
  }
  let result: boolean
  try {
    if (Array.isArray(args)) {
      result = await evalFlat(ctx, args)
    } else {
      result = await evalCond(ctx, args)
    }
  } catch (exc) {
    if (!(exc instanceof CondError)) throw exc
    const stderr = new TextEncoder().encode(exc.message + '\n')
    if (name === '[[' && exc.fatal) {
      // A bad [[ ]] operator is a bash PARSE error: the whole input
      // line dies, not just this command.
      throw new ExitSignal(2, stderr, null, 2)
    }
    return [
      null,
      new IOResult({ exitCode: exc.exitCode, stderr }),
      new ExecutionNode({ command: 'test', exitCode: exc.exitCode, stderr }),
    ]
  }
  const code = result ? 0 : 1
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'test', exitCode: code }),
  ]
}

/** The `test` / `[` / `[[` arm; `[` must close with `]`. */
export async function testBuiltin(call: BuiltinCall): Promise<Result> {
  const name = call.argv.name
  let testArgs = [...call.argv.operands]
  const testName = name === SB.BRACKET ? '[' : 'test'
  if (name === SB.BRACKET) {
    const last = testArgs[testArgs.length - 1]
    if (last !== undefined && wordText(last) === ']') {
      testArgs = testArgs.slice(0, -1)
    } else {
      const err = new TextEncoder().encode("[: missing `]'\n")
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: '[', exitCode: 2, stderr: err }),
      ]
    }
  }
  return handleTest(
    call.dispatch,
    call.namespace,
    testArgs,
    call.session,
    testName,
    sessionView(call.session, call.registry.policies),
  )
}
