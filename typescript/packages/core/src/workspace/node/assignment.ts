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

import { shellVoice } from '../../shell/voice.ts'
import { runInCommandScope } from '../../cache/index/scope.ts'
import type { RedirectResult } from '../../context/session_context.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import {
  buildAssocLiteral,
  buildIndexedLiteral,
  keyedWord,
  makeArray,
  type ShellArray,
} from '../../shell/array.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ArithError, DiscardSignal, ReadonlyVariableError } from '../../shell/errors.ts'
import { getText } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import type { ShellValue } from '../../shell/variable.ts'
import { traceAssignment } from '../../shell/xtrace.ts'
import { wordText } from '../../types.ts'
import type { SessionView } from '../../view/types.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { ok, result } from '../executor/builtins/shared.ts'
import { assignmentStatus } from '../executor/statement.ts'
import { globOptions, resolveGlobs } from '../expand/globs.ts'
import { expandAssignment, expandNode } from '../expand/node.ts'
import { expandAndClassify } from '../expand/parts.ts'
import type { ExecuteFn } from '../expand/types.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import {
  assignElement,
  conversionScalar,
  deref,
  pushWords,
  sessionView,
  subscriptIndex,
  varKind,
} from '../session/state.ts'

/** `buildIndexedLiteral` whose subscript failure ends the line. */
async function fatalIndexLiteral(
  held: ShellArray | null,
  items: readonly string[],
  append: boolean,
  indexOf: (subscript: string) => Promise<bigint>,
): Promise<ShellArray> {
  try {
    return await buildIndexedLiteral(held, items, append, indexOf)
  } catch (err) {
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

/**
 * Discard the line on a literal written to a readonly `key` before it is
 * expanded, as bash refuses it. The store refuses every other spelling once
 * its value and subscript are read, before the array would grow to the index
 * (`a[2**40]=x`).
 */
function refuseReadonly(view: SessionView, key: string): void {
  if (view.isReadonly(key, false)) {
    throw new DiscardSignal(encodeText(`${shellVoice()}${key}: readonly variable\n`))
  }
}

/** bash's refusal of an assignment subscript, naming its raw spelling (`m[$e]: bad array subscript`). */
function badSubscript(subscriptNode: TSNodeLike): DiscardSignal {
  return new DiscardSignal(
    encodeText(`${shellVoice()}${subscriptNode.text}: bad array subscript\n`),
  )
}

/**
 * One assignment's write, whose refusal is fatal: a readonly name or a
 * denial abandons the rest of the line (builtins like `export` merely fail
 * with 1 and continue), and an arithmetic error in a subscript or an `-i`
 * value ends the shell.
 */
async function landed<T>(write: Promise<T>): Promise<T> {
  try {
    return await write
  } catch (err) {
    if (err instanceof PolicyDenied) throw new DiscardSignal(encodeText(`${err.message}\n`))
    if (err instanceof ReadonlyVariableError) {
      throw new DiscardSignal(encodeText(`${shellVoice()}${err.message}\n`))
    }
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

/** One whole value through the session view; denial is fatal. */
async function assignVar(view: SessionView, key: string, value: ShellValue): Promise<void> {
  await landed(view.set(key, value, true))
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
    )
    return resolveGlobs(
      classified,
      registry,
      session.shellOptions.noglob === true,
      namespace.sessionLinks(session),
      globOptions(session),
    )
  })
  return resolved.map((w) => wordText(w))
}

const SUBSCRIPT_LITERAL_TYPES: ReadonlySet<string> = new Set([NT.WORD, NT.NUMBER])

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
): Promise<string> {
  const inner = subscriptNode.namedChildren.filter((sc) => sc.type !== NT.VARIABLE_NAME)
  const raw = subscriptNode.text.slice(name.length + 1, -1)
  if (inner.length === 0 || inner.every((sc) => SUBSCRIPT_LITERAL_TYPES.has(sc.type))) {
    return raw
  }
  const parts: string[] = []
  for (const sc of inner) {
    parts.push(await expandNode(sc, context, executeFn, callStack))
  }
  return parts.join('')
}

/**
 * Execute one top-level variable assignment (`a=1`, `a[i]+=v`).
 *
 * A literal is built with bash's own mechanics and stored whole through the
 * session view, but `a+=(x y)` onto an indexed array appends in the store.
 * Every other spelling (scalar, subscript, append) is one element write the
 * store makes in place, so an assignment costs its element, not the array;
 * the view owns the admission gate and the scalar/array invariant either way.
 */
export async function executeAssignment(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const session = context.session
  const text = getText(node)
  if (!text.includes('=')) return ok(text)
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
  const valNodes = node.namedChildren.filter(
    (c) => c.type !== NT.VARIABLE_NAME && c.type !== 'subscript',
  )
  const view = sessionView(session, context.frame.diagnostics)
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
    const kind = varKind(session, key)
    if (kind === 'assoc') {
      const { map, badWords } = buildAssocLiteral(session.assocs[key] ?? null, items, append)
      await assignVar(view, key, map)
      // A plain word in a keyed literal is dropped with a warning and the
      // assignment still succeeds; unlike a declaration's, this voice does
      // not quote the word (pinned on 5.2.37).
      return result(text, {
        exitCode: assignmentStatus(context.frame, subSeq),
        stderr: badWords
          .map(
            (word) =>
              `${shellVoice()}${key}: ${word}: must use subscript when assigning associative array\n`,
          )
          .join(''),
      })
    }
    if (append && kind === 'indexed' && items.every((word) => keyedWord(word) === null)) {
      // `arr+=(...)` starts at the extent, so it fills the hole a trailing
      // `unset arr[last]` left but skips interior ones.
      await landed(pushWords(session, key, items))
      return result(text, { exitCode: assignmentStatus(context.frame, subSeq) })
    }
    let held: ShellArray | null = append ? (session.arrays[key] ?? null) : null
    if (append && held === null) {
      const scalar = conversionScalar(session, key)
      held = scalar === null ? null : makeArray([scalar])
    }
    // A `[i]=v` element places at i and the next plain word continues from
    // there.
    const base = await fatalIndexLiteral(held, items, append, (sub) => subscriptIndex(session, sub))
    await assignVar(view, key, base)
    return result(text, { exitCode: assignmentStatus(context.frame, subSeq) })
  }
  let val = text.slice(eq + 1)
  if (firstVal !== undefined) {
    val = await expandAssignment(firstVal, context, executeFn, callStack)
  }
  if (xtrace) {
    const target = subscriptNode === null ? spelled : getText(subscriptNode)
    context.frame.diagnostics.push(encodeText(`${traceAssignment(target, val, append)}\n`))
  }
  let subscript: string | null = null
  if (subscriptNode !== null) {
    // bash discards the rest of the line on a bad assignment subscript
    // (status 1), naming the raw spelling (`m[$e]: bad array subscript`): a
    // blank one, an associative key that expands empty, or an index before
    // the first element. An indexed subscript that merely *expands* empty
    // stays legal (arithmetic on nothing is 0).
    if (subscriptNode.text.slice(spelled.length + 1, -1) === '') throw badSubscript(subscriptNode)
    subscript = await subscriptKeyText(subscriptNode, spelled, context, executeFn, callStack)
  }
  // `a=x` writes element 0 of an array and the key "0" of a map, keeping the
  // rest; `a+=x` appends onto it, and `n+=3` on an integer name adds
  // (`declare -i n=5; n+=3` stores 8).
  const status = await landed(
    assignElement(session, key, subscript, val, append, context.frame.diagnostics),
  )
  if (status === 'readonly') {
    throw new DiscardSignal(encodeText(`${shellVoice()}${key}: readonly variable\n`))
  }
  if (status === 'denied') throw new DiscardSignal(encodeText(`${key}: permission denied\n`))
  if (status === 'subscript' && subscriptNode !== null) throw badSubscript(subscriptNode)
  // Reassigning OPTIND (even to its current value) restarts the getopts
  // scan at the first letter of the word it names, as bash 5.2 does
  // (`OPTIND=1` midway through `-ab` makes getopts read `a` again).
  if (key === 'OPTIND') session.getoptsOptind = null
  return result(text, { exitCode: assignmentStatus(context.frame, subSeq) })
}
