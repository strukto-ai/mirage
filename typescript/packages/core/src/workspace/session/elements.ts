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

import type { SessionView } from '../../ops/types.ts'
import { PolicyDenied } from '../../policy/index.ts'
import {
  arrayCount,
  arrayExtent,
  arrayGet,
  arrayHas,
  arrayWith,
  type ShellArray,
} from '../../shell/array.ts'
import type { ShellValue } from '../../shell/variable.ts'
import type { Session } from './session.ts'
import {
  conversionScalar,
  subscriptIndex,
  ensureVarVisible,
  envGet,
  seedVar,
  stripKeyQuotes,
  visibleArrays,
  visibleAssocs,
  deref,
} from './state.ts'

const ELEMENT_REF = /^([A-Za-z_]\w*)(?:\[([\s\S]+)\])?$/

/**
 * Whether a `name` / `name[sub]` reference names a set value.
 *
 * What `test -v` asks. A bare name over an array checks element 0 (the
 * literal key `"0"` for an associative one), which is GNU's rule;
 * `name[@]` and `name[*]` ask whether any element is set. An
 * associative subscript is the key verbatim; an indexed one evaluates
 * as arithmetic, and its assignments land through `view`
 * (`[[ -v a[x=2] ]]` leaves x at 2, as bash does); null lands them
 * ungated, outside a workspace.
 */
export async function elementIsSet(
  session: Session,
  ref: string,
  view: SessionView | null = null,
): Promise<boolean> {
  const match = ELEMENT_REF.exec(ref)
  if (match?.[1] === undefined) return false
  const name = deref(session, match[1]) || match[1]
  const sub = match[2]
  const amap = visibleAssocs(session)[name]
  const arr = visibleArrays(session)[name]
  if (sub === undefined) {
    if (amap !== undefined) return amap['0'] !== undefined
    if (arr !== undefined) return arrayHas(arr, 0)
    return envGet(session, name) !== null
  }
  if (sub === '@' || sub === '*') {
    if (amap !== undefined) return Object.keys(amap).length > 0
    if (arr !== undefined) return arrayCount(arr) > 0
    return envGet(session, name) !== null
  }
  // The subscript arrives as the operand spelled it, so `test -v
  // 'm["x"]'` asks after key `x`, as the resolver reads it in
  // arithmetic and as bash removes the quotes.
  if (amap !== undefined) return amap[stripKeyQuotes(sub)] !== undefined
  const scalar = envGet(session, name)
  let held: ShellArray
  if (arr !== undefined) held = arr
  else if (scalar !== null) held = [scalar]
  else return false
  let idx = await subscriptIndex(session, sub, view)
  if (idx < 0) idx += arrayExtent(held)
  return arrayHas(held, idx)
}

/**
 * Assign one element (or a bare name resolved as element 0).
 *
 * The element mechanics are computed on a copy and the landing write
 * goes through the door as the whole variable the write produces, so a
 * refused write leaves nothing half-applied and a `preSession` rule
 * sees `m[k]=v` as a write to `m`. The subscript arrives already
 * expanded: an associative name takes it as the key verbatim, an
 * indexed one evaluates it as arithmetic. A null subscript is a bare
 * target, which bash resolves as element 0 of an array and a plain
 * scalar otherwise. Answers `"ok"`, `"denied"`, `"readonly"`, or
 * `"subscript"`; a preSession refusal from the door propagates so the
 * rule's own message reaches the caller.
 */
export async function assignElement(
  session: Session,
  view: SessionView | null,
  name: string,
  subscript: string | null,
  value: string,
  append = false,
): Promise<'ok' | 'denied' | 'readonly' | 'subscript'> {
  // An element write through a name reference lands on the target.
  name = deref(session, name) || name
  try {
    ensureVarVisible(session, name)
  } catch (error) {
    if (error instanceof PolicyDenied) return 'denied'
    throw error
  }
  if (session.readonlyVars.has(name)) return 'readonly'
  const amap = session.assocs[name]
  let stored: ShellValue
  if (amap !== undefined) {
    const key = subscript ?? '0'
    if (key === '') return 'subscript'
    const updated = { ...amap }
    updated[key] = append ? (amap[key] ?? '') + value : value
    stored = updated
  } else {
    let arr = session.arrays[name]
    if (subscript === null && arr === undefined) {
      stored = append ? (session.env[name] ?? '') + value : value
    } else {
      if (arr === undefined) {
        const scalar = conversionScalar(session, name)
        // An existing scalar becomes element 0, even when empty: bash
        // resolves `x[-1]` against the length-1 array that produces.
        arr = scalar === undefined ? [] : [scalar]
      }
      let idx = subscript === null ? 0 : await subscriptIndex(session, subscript, view)
      if (idx < 0) idx += arrayExtent(arr)
      if (idx < 0) return 'subscript'
      const base = append ? arrayGet(arr, idx) : ''
      stored = arrayWith(arr, idx, base + value)
    }
  }
  if (view !== null) {
    await view.set(name, stored)
    return 'ok'
  }
  seedVar(session, name, stored)
  return 'ok'
}
