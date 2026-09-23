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
import { ArithError } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { varHidden } from '../../../../utils/hidden.ts'
import { VarAttr } from '../../../../shell/variable.ts'
import { setAttr } from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import { visibleEnv } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, readonlyRefusal, refusal, requireView } from '../shared.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { READONLY_FLAGS, READONLY_USAGE } from './constants.ts'
import {
  assocBody,
  bashDeclareQuote,
  identifierFailure,
  identifierRefusal,
  premark,
  readonlyFunctions,
  splitDeclFlags,
  storeStagedArrays,
} from './declare.ts'
import type { Result } from '../types.ts'

function readonlyLines(session: SessionState, flags: Set<string>): string[] {
  // -a narrows to indexed arrays and -A to associative ones, as bash
  // does. -f selects functions, which mirage carries no readonly
  // attribute for, so that form lists nothing.
  if (flags.has('f')) return []
  const arraysOnly = flags.has('a')
  const assocsOnly = flags.has('A')
  const env = visibleEnv(session)
  const lines: string[] = []
  // A hidden readonly never prints even its bare `declare -r NAME` row.
  for (const name of [...session.readonlyVars]
    .filter((name) => !varHidden(session.hiddenVars, name))
    .sort(compareCodePoints)) {
    const arr = session.arrays[name]
    const amap = session.assocs[name]
    if (arr !== undefined && !assocsOnly) {
      const parts: string[] = []
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        if (v !== null && v !== undefined) {
          parts.push(`[${String(i)}]=${bashDeclareQuote(v)}`)
        }
      }
      lines.push(`declare -ar ${name}=(${parts.join(' ')})`)
      continue
    }
    if (amap !== undefined && !arraysOnly) {
      lines.push(`declare -Ar ${name}${assocBody(amap)}`)
      continue
    }
    if (arraysOnly || assocsOnly || arr !== undefined || amap !== undefined) continue
    if (name in env) {
      lines.push(`declare -r ${name}=${bashDeclareQuote(env[name] ?? '')}`)
    } else {
      lines.push(`declare -r ${name}`)
    }
  }
  return lines
}

/**
 * Mark names readonly, or print them (`readonly -p` / bare `readonly`).
 *
 * With no name operands, prints every readonly name as `declare -r` (or
 * `declare -ar` for arrays). Invalid options fail with status 2.
 */
export async function handleReadonly(
  assignments: string[],
  session: SessionState,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
  stored: string[] | null = null,
  assoc = false,
  shaping: ReadonlySet<VarAttr> = new Set(),
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, READONLY_FLAGS)
  if (bad !== null) {
    const err = new TextEncoder().encode(
      `bash: readonly: -${bad}: invalid option\n${READONLY_USAGE}`,
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'readonly', exitCode: 2, stderr: err }),
    ]
  }
  if (flags.has('f')) return readonlyFunctions(session, names)
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = readonlyLines(session, flags)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  const view = requireView(state)
  const errors: string[] = []
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      'readonly',
      session,
      view,
      arrays,
      VarAttr.Readonly,
      true,
      true,
      stored,
      assoc || flags.has('A'),
      errors,
      shaping,
    )
    if (refused !== null) return refused
  }
  for (const assign of names) {
    const badName = identifierRefusal('readonly', assign)
    if (badName !== null) {
      errors.push(badName)
      continue
    }
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('readonly', key)
      try {
        await premark(view, key, shaping)
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('readonly', err)
        if (err instanceof ArithError) return arithRefusal('readonly', err)
        throw err
      }
      // Ungated: the `view.set` above already put this name through the
      // gate, so the mark rides on that decision.
      setAttr(session, key, VarAttr.Readonly)
      if (stored !== null) stored.push(key)
    } else {
      // Gated, exactly as `export NAME` is. The bare form writes no
      // value, so it has no `view.set` to ride on, and marking through
      // `setAttr` walked straight past `preSession`: a deployment
      // refusing `AWS_*` still saw `readonly AWS_KEY` exit 0, create the
      // record, and freeze the name against every later legitimate write.
      try {
        await view.mark(assign, VarAttr.Readonly, true)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('readonly', err)
        throw err
      }
      if (stored !== null) stored.push(assign)
    }
  }
  if (errors.length > 0) return identifierFailure('readonly', errors)
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}
