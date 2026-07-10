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

import { resolvePath } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { toScope, scopePath } from './scope.ts'
import type { Result } from './scope.ts'

async function evalTest(
  dispatch: DispatchFn,
  argv: (string | PathSpec)[],
  cwd: string,
): Promise<boolean> {
  if (argv.length === 0) return false
  const firstArg = argv[0]
  if (firstArg === undefined) return false
  const first = scopePath(firstArg)
  if (first === '!' && argv.length > 1) {
    return !(await evalTest(dispatch, argv.slice(1), cwd))
  }
  if (argv.length === 1) return Boolean(first)
  if (argv.length === 2) {
    const op = scopePath(firstArg)
    const val = argv[1]
    if (val === undefined) return false
    if (op === '-z') return scopePath(val) === ''
    if (op === '-n') return scopePath(val) !== ''
    if (op === '-f') {
      // A relative string operand resolves against cwd, like bash:
      // `cd /data && test -f plain.txt` checks /data/plain.txt.
      if (!(val instanceof PathSpec) && scopePath(val) === '') return false
      const scope = val instanceof PathSpec ? val : toScope(resolvePath(scopePath(val), cwd))
      try {
        await dispatch('stat', scope)
        return true
      } catch {
        return false
      }
    }
    if (op === '-d') {
      if (!(val instanceof PathSpec) && scopePath(val) === '') return false
      const dirPath = val instanceof PathSpec ? '' : resolvePath(scopePath(val), cwd)
      const scope =
        val instanceof PathSpec
          ? val
          : new PathSpec({
              resourcePath: stripSlash(dirPath),
              virtual: dirPath,
              directory: dirPath,
              resolved: false,
            })
      try {
        await dispatch('readdir', scope)
        return true
      } catch {
        return false
      }
    }
  }
  if (argv.length === 3) {
    const leftArg = argv[0]
    const opArg = argv[1]
    const rightArg = argv[2]
    if (leftArg === undefined || opArg === undefined || rightArg === undefined) return false
    const left = scopePath(leftArg)
    const op = scopePath(opArg)
    const right = scopePath(rightArg)
    if (op === '=' || op === '==') return left === right
    if (op === '!=') return left !== right
    const li = Number(left)
    const ri = Number(right)
    if (!Number.isInteger(li) || !Number.isInteger(ri)) return false
    if (op === '-eq') return li === ri
    if (op === '-ne') return li !== ri
    if (op === '-lt') return li < ri
    if (op === '-le') return li <= ri
    if (op === '-gt') return li > ri
    if (op === '-ge') return li >= ri
  }
  return false
}

export async function handleTest(
  dispatch: DispatchFn,
  argv: (string | PathSpec)[],
  session: Session,
): Promise<Result> {
  const result = await evalTest(dispatch, argv, session.cwd)
  const code = result ? 0 : 1
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'test', exitCode: code }),
  ]
}
