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

import type { EvaluationContext } from '../evaluation.ts'
import { runInCommandScope } from '../../cache/index/scope.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  type ShellArray,
  arrayExtent,
  arrayGet,
  arraySet,
  arrayWith,
  buildAssocLiteral,
  buildIndexedLiteral,
} from '../../shell/array.ts'
import { ArithError, DiscardSignal } from '../../shell/errors.ts'
import { getText } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { type ShellValue, VarAttr } from '../../shell/variable.ts'
import { sessionEntry } from '../session/session.ts'
import { ReadonlyVariableError } from '../session/errors.ts'
import { traceAssignment } from '../../shell/xtrace.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import type { SessionView } from '../../view/types.ts'
import { wordText } from '../../types.ts'
import { assignmentStatus } from '../executor/statement.ts'
import { type ExecuteFn, expandNode } from '../expand/node.ts'
import { globOptions, resolveGlobs } from '../expand/globs.ts'
import { expandAndClassify } from '../expand/parts.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'

import { appended, conversionScalar, deref, sessionView, subscriptIndex } from '../session/state.ts'
import { ExecutionNode } from '../types.ts'
import { encodeText } from '../../shell/bytes.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

/** `subscriptIndex` whose failure ends the line, in bash's words. */
async function fatalIndex(
  context: EvaluationContext,
  subscript: string,
  view: SessionView,
): Promise<number> {
  const session = context.session
  try {
    return await subscriptIndex(session, subscript, view)
  } catch (err) {
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

/** `buildIndexedLiteral` whose subscript failure ends the line. */
async function fatalIndexLiteral(
  held: ShellArray | null,
  items: readonly string[],
  append: boolean,
  indexOf: (subscript: string) => Promise<number>,
): Promise<ShellArray> {
  try {
    return await buildIndexedLiteral(held, items, append, indexOf)
  } catch (err) {
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

/**
 * Discard the line on a write to a readonly `key` before its new value is
 * built: bash refuses an array literal before expanding it, and an element
 * write once its value and subscript are read, before the array would grow
 * to the index (`a[2**40]=x`). The store refuses every other spelling
 * (`assignVar`).
 */
function refuseReadonly(view: SessionView, key: string): void {
  if (view.isReadonly(key, false)) {
    throw new DiscardSignal(encodeText(`bash: ${key}: readonly variable\n`))
  }
}

/**
 * One assignment through the session view; denial is fatal.
 *
 * Every assignment spelling (scalar, array literal, subscript, append)
 * computes its resulting value and stores through `view.set`, so the
 * gate and the storage invariant live in the session view, not here. A
 * readonly name or a denial is a fatal variable-assignment error that
 * abandons the rest of the line (builtins like `export` merely fail with 1
 * and continue).
 */
async function assignVar(
  view: SessionView,
  key: string,
  value: ShellValue,
  assigned: ReadonlySet<number | string> | null = null,
  added: string | null = null,
): Promise<void> {
  try {
    await view.set(key, value, true, assigned, added)
  } catch (err) {
    if (err instanceof PolicyDenied || err instanceof ReadonlyVariableError) {
      throw new DiscardSignal(encodeText(`${err.message}\n`))
    }
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

// Array-literal elements behave like any other shell word list: command
// substitutions word-split and globs resolve to matches
// (`a=($(cmd) /data/*.txt)`), with zero-match globs kept literal.
export async function expandArrayItems(
  arrayNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
): Promise<string[]> {
  const session = context.session
  // A bare assignment is no command, but its glob reads listings all the
  // same, so it gets a scope of its own.
  const resolved = await runInCommandScope(async () => {
    const classified = await expandAndClassify(
      arrayNode.namedChildren,
      context,
      executeFn,
      registry,
      session.cwd,
      callStack,
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
    return resolveGlobs(
      classified,
      registry,
      session.shellOptions.noglob === true,
      namespace,
      globOptions(session),
    )
  })
  return resolved.map((w) => wordText(w))
}

const SUBSCRIPT_LITERAL_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER, NT.ERROR])

/**
 * The expanded subscript text of one `name[...]=` assignment.
 *
 * A purely literal subscript keeps its raw spelling, spaces included
 * (bash stores `m[ k ]` under the key `" k "`); anything carrying an
 * expansion or quoting expands node by node so `m[$k]` and `m["a b"]`
 * resolve with quote removal. The associative path uses the result as
 * the key verbatim; the indexed path evaluates it as arithmetic.
 */
async function subscriptKeyText(
  subscriptNode: TSNodeLike,
  name: string,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string> {
  const inner = subscriptNode.namedChildren.filter((sc) => sc.type !== NT.VARIABLE_NAME)
  const raw = subscriptNode.text.slice(name.length + 1, -1)
  if (inner.length === 0 || inner.every((sc) => SUBSCRIPT_LITERAL_TYPES.has(sc.type))) {
    return raw
  }
  const parts: string[] = []
  for (const sc of inner) {
    parts.push(await expandNode(sc, context, executeFn, callStack, view))
  }
  return parts.join('')
}

/**
 * Execute one top-level variable assignment (`a=1`, `a[i]+=v`).
 *
 * Every spelling — scalar, array literal, subscript, append — is
 * computed with bash's own mechanics on a copy of the held value and
 * then stored through the session view, which owns the admission gate
 * and the scalar/array invariant.
 */
export async function executeAssignment(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
): Promise<Result> {
  const session = context.session
  const text = getText(node)
  if (!text.includes('=')) {
    return [null, new IOResult(), new ExecutionNode({ command: text, exitCode: 0 })]
  }
  const subSeq = context.frame.cmdsubSeq
  const subscriptNode = node.namedChildren.find((c) => c.type === 'subscript') ?? null
  const nameSource = subscriptNode ?? node
  const nameNode = nameSource.namedChildren.find((c) => c.type === NT.VARIABLE_NAME)
  const eq = text.indexOf('=')
  const spelled = nameNode !== undefined ? nameNode.text : text.slice(0, eq)
  // A name reference assigns to its target, whatever the shape of the
  // assignment; an unaimed one (`declare -n r; r=v`) resolves to itself
  // and takes the value as the target's name. The spelling is kept for
  // slicing the subscript out of the source.
  const key = deref(session, spelled) || spelled
  const append = node.children.some((c) => c.type === '+=')
  // `+=` on an integer adds, element by element too (`appended`).
  const integer = sessionEntry(session.vars, key)?.attrs.has(VarAttr.Integer) === true
  const valNodes = node.namedChildren.filter(
    (c) => c.type !== NT.VARIABLE_NAME && c.type !== 'subscript',
  )
  // Every branch below computes its resulting value with bash's own
  // mechanics on a copy, then stores through the one session view,
  // which owns the gate and the scalar/array invariant.
  const view = sessionView(session, registry.policies, context.frame.diagnostics)
  const firstVal = valNodes[0]
  // `set -x` traces the name as typed, before the store refuses it.
  const xtrace = session.shellOptions.xtrace === true
  if (firstVal?.type === NT.ARRAY) {
    if (xtrace) {
      // A literal traces as typed, its words one space apart.
      const words = firstVal.namedChildren
        .filter((c) => c.type !== NT.COMMENT)
        .map(getText)
        .join(' ')
      context.frame.diagnostics.push(encodeText(`+ ${spelled}${append ? '+=' : '='}(${words})\n`))
    }
    refuseReadonly(view, key)
    const items = await expandArrayItems(
      firstVal,
      context,
      executeFn,
      registry,
      namespace,
      callStack,
    )
    const heldMap = session.assocs[key]
    if (heldMap !== undefined) {
      const { map, badWords } = buildAssocLiteral(heldMap, items, append)
      await assignVar(view, key, map)
      // A plain word in a keyed literal is dropped with a warning and the
      // assignment still succeeds; unlike a declaration's, this voice does
      // not quote the word (pinned on 5.2.37).
      const errBytes = encodeText(
        badWords
          .map(
            (word) =>
              `bash: ${key}: ${word}: must use subscript when assigning associative array\n`,
          )
          .join(''),
      )
      const mapCode = assignmentStatus(context.frame, subSeq)
      return [
        null,
        new IOResult({ exitCode: mapCode, stderr: errBytes.length > 0 ? errBytes : null }),
        new ExecutionNode({ command: text, exitCode: mapCode, stderr: errBytes }),
      ]
    }
    let held: ShellArray | null = session.arrays[key] ?? null
    if (append && held === null) {
      const scalar = conversionScalar(session, key)
      held = scalar === undefined ? null : [scalar]
    }
    // `arr+=(...)` starts at the extent, so it fills the hole a
    // trailing `unset arr[last]` left but skips interior ones; a
    // `[i]=v` element places at i and the next plain word continues
    // from there.
    const base = await fatalIndexLiteral(held, items, append, (sub) =>
      subscriptIndex(session, sub, view),
    )
    await assignVar(view, key, base)
    const arrCode = assignmentStatus(context.frame, subSeq)
    return [
      null,
      new IOResult({ exitCode: arrCode }),
      new ExecutionNode({ command: text, exitCode: arrCode }),
    ]
  }
  let val = text.slice(eq + 1)
  if (firstVal !== undefined) {
    val = await expandNode(firstVal, context, executeFn, callStack, view)
  }
  if (xtrace) {
    const target = subscriptNode === null ? spelled : getText(subscriptNode)
    context.frame.diagnostics.push(encodeText(`${traceAssignment(target, val, append)}\n`))
  }
  if (subscriptNode !== null) {
    const subText = await subscriptKeyText(
      subscriptNode,
      spelled,
      context,
      executeFn,
      callStack,
      sessionView(session, registry.policies, context.frame.diagnostics),
    )
    const heldMap = session.assocs[key]
    const rawSub = subscriptNode.text.slice(spelled.length + 1, -1)
    if (rawSub.trim() === '' || (heldMap !== undefined && subText === '')) {
      // bash discards the rest of the line on a bad assignment subscript
      // (status 1), naming the raw spelling (`m[$e]: bad array
      // subscript`). An indexed subscript that merely *expands*
      // empty stays legal (arithmetic on nothing is 0), so only the
      // associative kind checks the expanded text.
      const nameText = text.slice(0, eq).replace(/\+$/, '')
      throw new DiscardSignal(encodeText(`bash: ${nameText}: bad array subscript\n`))
    }
    if (heldMap !== undefined) {
      // The subscript is the key: no arithmetic, `m[1+1]` writes the
      // key "1+1".
      const newMap = { ...heldMap }
      const [slot, added] = append ? appended(heldMap[subText] ?? '', val, integer) : [val, null]
      newMap[subText] = slot
      await assignVar(view, key, newMap, new Set([subText]), added)
      const mapCode = assignmentStatus(context.frame, subSeq)
      return [
        null,
        new IOResult({ exitCode: mapCode }),
        new ExecutionNode({ command: text, exitCode: mapCode }),
      ]
    }
    let arr: ShellArray | undefined = session.arrays[key]
    if (arr === undefined) {
      const scalar = conversionScalar(session, key)
      arr = scalar === undefined ? [] : [scalar]
    }
    let idx = await fatalIndex(context, subText, view)
    if (idx < 0) idx += arrayExtent(arr)
    if (idx < 0) {
      // Same fatal shape as the empty subscript above.
      const nameText = text.slice(0, eq).replace(/\+$/, '')
      throw new DiscardSignal(encodeText(`bash: ${nameText}: bad array subscript\n`))
    }
    refuseReadonly(view, key)
    const [slot, added] = append ? appended(arrayGet(arr, idx), val, integer) : [val, null]
    await assignVar(view, key, arrayWith(arr, idx, slot), new Set([idx]), added)
    const subCode = assignmentStatus(context.frame, subSeq)
    return [
      null,
      new IOResult({ exitCode: subCode }),
      new ExecutionNode({ command: text, exitCode: subCode }),
    ]
  }
  const heldMap = session.assocs[key]
  const heldArr = session.arrays[key]
  let [stored, added]: [string, string | null] = [val, null]
  if (append) {
    // `a+=x` appends onto element 0 (key "0" of a map); `n+=3` on an
    // integer name adds: `declare -i n=5; n+=3` stores 8.
    let old: string
    if (heldMap !== undefined) old = heldMap['0'] ?? ''
    else if (heldArr !== undefined) old = arrayGet(heldArr, 0)
    else old = session.env[key] ?? ''
    ;[stored, added] = appended(old, val, integer)
  }
  if (heldMap !== undefined) {
    // `m=x` on an associative array writes the literal key "0" and
    // keeps every other key, as bash does.
    const newMap = { ...heldMap }
    newMap['0'] = stored
    await assignVar(view, key, newMap, new Set(['0']), added)
  } else if (heldArr !== undefined) {
    // `a=x` writes element 0 and keeps the rest.
    const newArr = [...heldArr]
    arraySet(newArr, 0, stored)
    await assignVar(view, key, newArr, new Set([0]), added)
  } else {
    await assignVar(view, key, stored, null, added)
  }
  // Reassigning OPTIND (even to its current value) restarts the getopts
  // scan, matching bash's internal char pointer.
  if (key === 'OPTIND') session.getoptsOptind = null
  const code = assignmentStatus(context.frame, subSeq)
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: text, exitCode: code }),
  ]
}
