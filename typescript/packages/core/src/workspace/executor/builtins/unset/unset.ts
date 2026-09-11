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
import { ArithError, ExitSignal } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { arrayExtent, arrayUnset } from '../../../../shell/array.ts'
import { varHidden } from '../../../../utils/hidden.ts'
import { sessionEntry } from '../../../session/session.ts'
import { deref } from '../../../session/state.ts'
import type { Session } from '../../../session/session.ts'
import { envGet, subscriptIndex, visibleArrays, visibleAssocs } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { refusal, requireView } from '../shared.ts'
import { readonlyFunctionUnset } from '../declare/declare.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'
import { TARGET_RE } from '../constants.ts'

/**
 * Clear what the env door does not own after a whole-variable unset.
 *
 * The scalar half is the view's (`unset` deleted it, or quietly kept
 * it for a hidden name — a direct delete here would undo that
 * refusal); this clears the array storage and the getopts residue.
 * The array delete keeps a hidden name too: the embedder can seed
 * `session.arrays` before narrowing, so a hidden array exists and is
 * as much the host's to keep as the scalar the view protected.
 */
function unsetVariable(session: Session, name: string): void {
  if (!varHidden(session.hiddenVars, name)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.vars[name]
  }
  if (name === 'OPTIND') session.getoptsOptind = null
}

/**
 * Clear one array element, or a scalar addressed as `base[0]`.
 *
 * Clearing an element keeps the indices of the elements after it, as bash
 * does: it leaves a hole, which neither expands in `${arr[@]}` nor counts
 * toward `${#arr[@]}` but keeps `${arr[i]}` addressing the same values. A
 * subscript on a scalar names element 0 only: `x[0]` unsets the scalar
 * and any other subscript reports `notarray`. A subscript on a name that
 * holds nothing at all is a silent no-op, but on an existing array a
 * negative subscript still below zero after the extent is added reports
 * `subscript`.
 *
 * The element mechanics are the builtin's own, but every landing write
 * still mutates `base`'s session state, so it clears the plane's gate
 * first: for an array base the view's env half is empty, so `view.unset`
 * is exactly the gate, and for a scalar's element 0 it is the whole
 * unset itself. Validation errors write nothing and so never ask.
 */
/**
 * `subscriptIndex` whose failure ends the line, in bash's words: `unset
 * 'a[1/0]'` aborts with `1/0: division by 0`.
 */
async function fatalIndex(session: Session, subscript: string, view: SessionView): Promise<number> {
  try {
    return await subscriptIndex(session, subscript, view)
  } catch (err) {
    if (err instanceof ArithError) {
      throw new ExitSignal(1, new TextEncoder().encode(`bash: ${err.message}\n`), null, 1)
    }
    throw err
  }
}

async function unsetElement(
  session: Session,
  view: SessionView,
  base: string,
  subscript: string,
): Promise<'ok' | 'notarray' | 'subscript'> {
  const amap = sessionEntry(visibleAssocs(session), base)
  if (amap !== undefined) {
    // The subscript is the key, verbatim: `unset "m[1+1]"` removes the
    // key "1+1", and a key that is not there (GNU pins `unset "m[@]"`
    // on an associative array as this same no-op) answers quietly
    // without a write.
    if (!Object.hasOwn(amap, subscript)) return 'ok'
    const next = { ...amap }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete next[subscript]
    await view.set(base, next)
    return 'ok'
  }
  const arr = sessionEntry(visibleArrays(session), base)
  if (arr === undefined) {
    // Visible reads on purpose: a hidden base answers the unset
    // branch's silent no-op instead of a denial that would leak the
    // name's existence.
    if (envGet(session, base) === null) return 'ok'
    if ((await fatalIndex(session, subscript, view)) !== 0) return 'notarray'
    await view.unset(base)
    return 'ok'
  }
  let idx = await fatalIndex(session, subscript, view)
  if (idx < 0) {
    idx += arrayExtent(arr)
    if (idx < 0) return 'subscript'
  }
  const next = [...arr]
  arrayUnset(next, idx)
  await view.set(base, next)
  return 'ok'
}

/**
 * Unset shell variables, arrays, or functions, with bash's flags.
 *
 * `-v` targets a variable only, `-f` a function only, and a bare name a
 * variable if one exists or else a function. A `name[idx]` operand clears
 * one element; the readonly guard resolves it to the base name first,
 * since that is what `readonly` records. `-n` (unset a nameref itself)
 * has no referent here — mirage has no nameref attribute — so it matches
 * bash on a non-nameref name and leaves it untouched.
 */
export async function handleUnset(
  args: string[],
  session: Session,
  state: SessionView | null = null,
): Promise<Result> {
  let mode: 'auto' | 'v' | 'f' | 'n' = 'auto'
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-') && args[i] !== '-') {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (/^-[vfn]+$/.test(tok)) {
      if (tok.includes('f')) mode = 'f'
      else if (tok.includes('n')) mode = 'n'
      else mode = 'v'
      i += 1
      continue
    }
    const err = new TextEncoder().encode(`bash: unset: ${tok}: invalid option\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'unset', exitCode: 2, stderr: err }),
    ]
  }
  for (const name of args.slice(i)) {
    if (mode === 'n') {
      // `unset -n` drops the reference itself rather than its target;
      // on a plain variable bash unsets it. Ungated-by-target unset.
      try {
        await requireView(state).unset(name, false)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('unset', err)
        throw err
      }
      continue
    }
    if (mode === 'f') {
      if (session.readonlyFunctions.has(name)) return readonlyFunctionUnset(name)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.functions[name]
      continue
    }
    const match = TARGET_RE.exec(name)
    const subscript = match?.[2]
    const isElement = subscript !== undefined
    // `readonly arr` records the base name, so an `arr[i]` operand has to
    // be resolved before the guard, as bash does (which also names the
    // base, not the element, in the error).
    const base = match?.[1] ?? name
    if (session.readonlyVars.has(base)) {
      const err = new TextEncoder().encode(
        `bash: unset: ${base}: cannot unset: readonly variable\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    const existed =
      isElement || name in session.env || name in session.arrays || name in session.assocs
    // Both spellings clear the preSession gate for the base name: the
    // whole-variable unset through the view's env half, an element
    // unset inside unsetElement, so `unset 'X[0]'` cannot sidestep a
    // policy that vetoes `unset X`.
    let status: 'ok' | 'notarray' | 'subscript'
    try {
      if (subscript !== undefined) {
        status = await unsetElement(session, requireView(state), base, subscript)
      } else {
        await requireView(state).unset(name)
        unsetVariable(session, deref(session, name) || name)
        status = 'ok'
      }
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('unset', err)
      throw err
    }
    if (status !== 'ok') {
      // bash names the base for "not an array variable" but prints only
      // the bracketed part for a bad subscript.
      const detail =
        status === 'notarray'
          ? `unset: ${base}: not an array variable`
          : `unset: ${name.slice(base.length)}: bad array subscript`
      const err = new TextEncoder().encode(`bash: ${detail}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    if (mode === 'auto' && !existed && name in session.functions) {
      if (session.readonlyFunctions.has(name)) return readonlyFunctionUnset(name)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.functions[name]
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'unset', exitCode: 0 })]
}

/** The `unset` arm. */
export async function unsetBuiltin(call: BuiltinCall): Promise<Result> {
  return handleUnset(
    [...call.argv.args],
    call.session,
    sessionView(call.session, call.registry.policies),
  )
}
