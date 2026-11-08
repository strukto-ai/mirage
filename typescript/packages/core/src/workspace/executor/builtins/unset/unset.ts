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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import type { Policies } from '../../../../policy/index.ts'
import { BASH_LINENO, FUNCNAME } from '../../../../shell/constants.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { deref, sessionView, unsetElement } from '../../../session/state.ts'
import { TARGET_RE } from '../constants.ts'
import { flagHelp } from '../help/help.ts'
import type { SubscriptFn } from '../../../expand/types.ts'
import {
  builtinUsage,
  fail,
  finish,
  identifierLine,
  requireView,
  subscriptExpansion,
} from '../shared.ts'
import type { BuiltinCall } from '../types.ts'

/**
 * Clear the getopts residue after a whole-variable unset.
 *
 * The record itself is the view's to drop, scalar or array alike: it
 * keeps a hidden name, and inside a function it may put back a value an
 * enclosing scope saved.
 */
function unsetVariable(session: SessionState, name: string): void {
  if (name === 'OPTIND') session.getoptsOptind = null
  if (name === FUNCNAME) session.functionNames = null
}

/**
 * Clear one array element, or a scalar addressed as `base[0]`, as one gated
 * write, so a denial leaves the array untouched.
 *
 * Clearing an element keeps the indices of the elements after it, as bash
 * does: it leaves a hole, which neither expands in `${arr[@]}` nor counts
 * toward `${#arr[@]}` but keeps `${arr[i]}` addressing the same values. A
 * subscript on a scalar names element 0 only, and a subscript on a name
 * that holds nothing at all, or a hidden one, is a silent no-op. A subscript
 * that does not evaluate ends the line, in bash's words: `unset 'a[1/0]'`
 * aborts with `1/0: division by 0`.
 */
async function unsetOne(
  session: SessionState,
  base: string,
  subscript: string,
  policies: Policies | null = null,
): Promise<string> {
  try {
    return await unsetElement(session, policies, base, subscript)
  } catch (err) {
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

/** bash's refusal to unset a readonly variable or function. */
function readonly(name: string, kind: 'variable' | 'function'): string {
  return `${shellVoice()}unset: ${name}: cannot unset: readonly ${kind}\n`
}

/**
 * Unset shell variables, arrays, or functions, with bash's flags.
 *
 * `-v` targets a variable only, `-f` a function only, and a bare name a
 * variable if one exists or else a function. A `name[idx]` operand clears
 * one element; the readonly guard resolves it to the base name first,
 * since that is what `readonly` records. `-n` unsets a name reference
 * itself, where a bare name unsets what the reference points at. A name
 * it cannot unset is reported and the rest still go, for status 1.
 */
export async function handleUnset(
  args: string[],
  session: SessionState,
  state: SessionView | null = null,
  policies: Policies | null = null,
  subscripts: SubscriptFn | null = null,
): Promise<RedirectResult> {
  if (args[0] === '--help') {
    const answered = flagHelp('unset')
    if (answered !== null) return answered
  }
  const letters = new Set<string>()
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-') && args[i] !== '-') {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (/^-[vfn]+$/.test(tok)) {
      for (const letter of tok.slice(1)) letters.add(letter)
      i += 1
      continue
    }
    return fail(
      'unset',
      `${shellVoice()}unset: ${tok}: invalid option\n${builtinUsage('unset')}`,
      2,
    )
  }
  if (letters.has('f') && letters.has('v')) {
    return fail(
      'unset',
      `${shellVoice()}unset: cannot simultaneously unset a function and a variable\n`,
    )
  }
  const mode = (['f', 'n', 'v'] as const).find((m) => letters.has(m)) ?? 'auto'
  const errors: string[] = []
  for (const name of args.slice(i)) {
    const view = requireView(state)
    if (letters.has('v') && !TARGET_RE.test(name)) {
      // Only a variable must be named as one: without -v bash falls back
      // to the function table, which takes any name.
      errors.push(`${identifierLine('unset', name)}\n`)
      continue
    }
    if (mode === 'n') {
      // `unset -n` drops the reference itself rather than its target;
      // on a plain variable bash unsets it. Ungated-by-target unset. A
      // frozen reference refuses, writable target or not.
      if (view.isReadonly(name, false)) {
        errors.push(readonly(name, 'variable'))
        continue
      }
      if (name === BASH_LINENO) {
        errors.push(`${shellVoice()}unset: ${name}: cannot unset\n`)
        continue
      }
      try {
        await view.unset(name, false)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        errors.push(`${err.message}\n`)
      }
      continue
    }
    if (mode === 'f') {
      if (session.readonlyFunctions.has(name)) {
        errors.push(readonly(name, 'function'))
        continue
      }
      session.removeFunction(name)
      continue
    }
    const match = TARGET_RE.exec(name)
    let subscript = match?.[2]
    const isElement = subscript !== undefined
    // `readonly arr` records the base name, so an `arr[i]` operand has to
    // be resolved before the guard, as bash does, and a reference to the
    // variable it reaches: bash names that variable, not the element or
    // the reference, in the error.
    const base = match?.[1] ?? name
    if (view.isReadonly(base)) {
      errors.push(readonly(deref(session, base), 'variable'))
      continue
    }
    if (!isElement && deref(session, base) === BASH_LINENO) {
      errors.push(`${shellVoice()}unset: ${name}: cannot unset\n`)
      continue
    }
    const existed =
      isElement || name in session.env || name in session.arrays || name in session.assocs
    // Both spellings clear the preSession gate for the base name: the
    // whole-variable unset through the view's env half, an element
    // unset inside unsetOne, so `unset 'X[0]'` cannot sidestep a
    // policy that vetoes `unset X`.
    let status: string
    try {
      if (subscript !== undefined) {
        if (subscripts !== null) subscript = await subscripts(subscript)
        status = await unsetOne(session, base, subscript, policies)
      } else {
        await view.unset(name)
        unsetVariable(session, deref(session, name) || name)
        status = 'ok'
      }
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      errors.push(`${err.message}\n`)
      continue
    }
    if (status !== 'ok') {
      // bash names the base for "not an array variable" but prints only
      // the bracketed part for a bad subscript.
      const detail =
        status === 'notarray'
          ? `unset: ${base}: not an array variable`
          : `unset: ${name.slice(base.length)}: bad array subscript`
      errors.push(`${shellVoice()}${detail}\n`)
      continue
    }
    if (mode === 'auto' && !existed && name in session.functions) {
      if (session.readonlyFunctions.has(name)) {
        errors.push(readonly(name, 'function'))
        continue
      }
      session.removeFunction(name)
    }
  }
  return finish('unset', errors)
}

/** The `unset` arm. */
export async function unsetBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handleUnset(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
    call.registry.policies,
    subscriptExpansion(call),
  )
}
