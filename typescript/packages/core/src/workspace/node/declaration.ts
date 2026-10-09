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

import type { ParseScope } from '../../shell/parse/scope.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { DiscardSignal } from '../../shell/errors.ts'
import { getDeclarationKeyword, getText } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { VarAttr, VarKind } from '../../shell/variable.ts'
import { sessionEntry } from '../session/session.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import {
  handleDeclareFunctions,
  handleDeclarePrint,
  handleExport,
  handleLocal,
  handleReadonly,
  noteLocalArray,
} from '../executor/builtins/index.ts'
import {
  LISTED_ATTRIBUTES,
  VISIBLE_SCOPE_BUILTINS,
} from '../executor/builtins/declare/constants.ts'
import {
  declaredKind,
  heldValue,
  kindConflict,
  startLocal,
} from '../executor/builtins/declare/declare.ts'
import { traceArray, traceCommand } from '../../shell/xtrace.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { type ExecuteFn, expandNode } from '../expand/node.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'

import { conversionScalar, ensureVarVisible, seedVar, sessionView } from '../session/state.ts'
import { ExecutionNode } from '../types.ts'
import { expandArrayItems } from './assignment.ts'
import type { DeclarationOperand } from '../executor/builtins/declare/types.ts'
import { encodeText } from '../../shell/bytes.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

/**
 * Fold kind-conversion refusals into a declaration's result.
 *
 * GNU reports `cannot convert indexed to associative array` per refused
 * name on stderr and fails the builtin with 1 while the other operands
 * still declare, so the refusals ride the handler's own result rather
 * than replacing it.
 */
function mergeConversionErrors(result: Result, errors: readonly string[]): Result {
  if (errors.length === 0) return result
  const [stream, io, node] = result
  const extra = encodeText(errors.join('\n') + '\n')
  const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array(0)
  const merged = new Uint8Array(prior.length + extra.length)
  merged.set(prior, 0)
  merged.set(extra, prior.length)
  const newIo = new IOResult({
    exitCode: 1,
    stderr: merged,
    reads: io.reads,
    writes: io.writes,
    cache: io.cache,
  })
  return [stream, newIo, new ExecutionNode({ command: node.command, exitCode: 1, stderr: merged })]
}

// Every letter GNU's `declare` accepts, so a typo refuses with the usage
// line instead of being silently dropped. `-a`/`-A` are kinds, not
// attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
// /`-I` are modes the handlers read. `-n` stores the reference and every
// reader and writer resolves through it (`deref` in `session/state`).
const DECLARE_LETTERS: ReadonlySet<string> = new Set('aAfFgiIlnprtux')
const DECLARE_USAGE =
  'declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]'
// The stored attributes a `-letter` / `+letter` toggles.
const ATTR_LETTERS: ReadonlyMap<string, VarAttr> = new Map([
  ['i', VarAttr.Integer],
  ['l', VarAttr.Lower],
  ['u', VarAttr.Upper],
  ['n', VarAttr.Nameref],
  ['t', VarAttr.Trace],
  ['x', VarAttr.Export],
  ['r', VarAttr.Readonly],
])
// The attributes that shape a value as it stores.
const SHAPING: ReadonlySet<VarAttr> = new Set([VarAttr.Integer, VarAttr.Lower, VarAttr.Upper])
// `-l` displaces `-u` and vice versa; the record keeps one.
const DISPLACES: ReadonlyMap<string, VarAttr> = new Map([
  ['l', VarAttr.Upper],
  ['u', VarAttr.Lower],
])

/**
 * The refusal a `declare` family option cluster earns, if any.
 *
 * An unknown letter is GNU's `invalid option` plus the usage line, exit
 * 2, and it wins over every other check because bash refuses the
 * cluster before it looks at a single operand.
 */
function declareOptionRefusal(
  cmd: string,
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
): Result | null {
  const bad = [...flagChars, ...plusChars]
    .sort(compareCodePoints)
    .find((c) => !DECLARE_LETTERS.has(c))
  if (bad === undefined) return null
  const sign = flagChars.has(bad) ? '-' : '+'
  const err = encodeText(`bash: ${cmd}: ${sign}${bad}: invalid option\n${DECLARE_USAGE}\n`)
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 2, stderr: err }),
  ]
}

/**
 * The attribute marks a declaration puts on each operand once it lands, in
 * order, readonly last.
 *
 * The letters that shape a value (`-i -l -u`) are stored as attributes and
 * applied by the session view on every *later* write, which is GNU's rule:
 * `v=MiXeD; declare -l v` keeps `MiXeD`, and the next `v=ABC` stores `abc`.
 * So this marks and never rewrites. `-l` and `-u` are exclusive: setting
 * one clears the other, and a cluster naming both (`-lu`, `-ul`) sets
 * neither, both pinned on 5.2.37. A `+` letter clears; `+r` is not an off
 * toggle, since it is refused on a readonly name (`plusRefusal`) and a
 * no-op otherwise. `r` lands last, as each operand's own last step:
 * `declare -rl L=ABC L=DEF` keeps `abc` and refuses the second write.
 */
function declaredMarks(
  flagChars: ReadonlySet<string>,
  plusChars: ReadonlySet<string>,
): (readonly [VarAttr, boolean])[] {
  const on = new Set<string>()
  for (const c of 'iluntxr') if (flagChars.has(c) && !plusChars.has(c)) on.add(c)
  if (on.has('l') && on.has('u')) {
    on.delete('l')
    on.delete('u')
  }
  const marks: (readonly [VarAttr, boolean])[] = []
  for (const c of 'xiluntr') {
    const attr = ATTR_LETTERS.get(c)
    if (attr === undefined) continue
    if (on.has(c)) {
      marks.push([attr, true])
      const displaced = DISPLACES.get(c)
      if (displaced !== undefined) marks.push([displaced, false])
    } else if (plusChars.has(c) && c !== 'r') {
      marks.push([attr, false])
    }
  }
  return marks
}

/**
 * Execute one declaration statement (export/local/declare/readonly).
 *
 * The executor only reads the operands: it expands them and sorts out the
 * option letters, keeping the words and the staged array literals in the
 * order typed, then hands them to the builtin handler that owns the
 * keyword, which marks each operand with the attribute letters (`-x`,
 * `-i`, `-l`) at its place, so `declare -rx X=1` keeps both marks.
 */
export async function executeDeclaration(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  namespace: Namespace,
  callStack: CallStack | null,
  parser?: ParseScope,
): Promise<Result> {
  const session = context.session
  const keyword = getDeclarationKeyword(node)
  // Array literals are staged, not stored: `readonly -a a=(y)` on an
  // already-readonly name has to fail with the old value intact. They keep
  // their place among the words, since bash marks each name in the order
  // typed.
  const operands: DeclarationOperand[] = []
  // Option words are kept verbatim, in order, so `--` survives as an
  // end-of-options marker and the handlers can name the *first* bad option
  // letter the way bash does.
  const flagWords: string[] = []
  const flagChars = new Set<string>()
  const plusChars = new Set<string>()
  let optsDone = false
  const traced: string[] = []
  const view = sessionView(session, registry.policies, context.frame.diagnostics)
  for (const child of node.namedChildren) {
    if (child.type === NT.VARIABLE_ASSIGNMENT) {
      const valNodes = child.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
      const firstVal = valNodes[0]
      if (firstVal?.type === NT.ARRAY) {
        const text = getText(child)
        const eq = text.indexOf('=')
        const key = eq >= 0 ? text.slice(0, eq) : text
        const append = key.endsWith('+')
        const name = append ? key.slice(0, -1) : key
        traced.push(name)
        operands.push({
          name,
          append,
          items: await expandArrayItems(
            firstVal,
            context,
            executeFn,
            registry,
            namespace,
            callStack,
          ),
        })
        continue
      }
      const expanded = await expandNode(child, context, executeFn, callStack, view)
      operands.push(expanded)
      traced.push(expanded)
    } else if (
      child.type === NT.SIMPLE_EXPANSION ||
      child.type === NT.EXPANSION ||
      child.type === NT.CONCATENATION ||
      child.type === NT.WORD ||
      // A bare `readonly NAME` / `export NAME` operand parses as a
      // variable_name, not a word, and a quoted assignment
      // (`export 'FOO=bar'`) as a plain string operand.
      child.type === NT.VARIABLE_NAME ||
      child.type === NT.STRING ||
      child.type === NT.RAW_STRING ||
      child.type === NT.ANSI_C_STRING ||
      child.type === NT.TRANSLATED_STRING
    ) {
      const expanded = await expandNode(child, context, executeFn, callStack, view)
      // An *unquoted* expansion that came back empty is removed by
      // word splitting, so `export $UNSET` is a bare `export` and
      // prints the listing. A quoted one is a real, empty operand:
      // GNU answers both `export ""` and `export "$UNSET"` with
      // ``export: `': not a valid identifier``, so it has to reach
      // the builtin rather than vanish here.
      if (expanded === '' && (child.type === NT.SIMPLE_EXPANSION || child.type === NT.EXPANSION))
        continue
      traced.push(expanded)
      if (!optsDone && expanded.startsWith('-') && expanded.length > 1) {
        flagWords.push(expanded)
        if (expanded === '--') optsDone = true
        else for (const ch of expanded.slice(1)) flagChars.add(ch)
      } else if (
        !optsDone &&
        expanded.startsWith('+') &&
        expanded.length > 1 &&
        (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
      ) {
        // `+attr` turns an attribute off. Only the declare family
        // reads it: `export +x` and `readonly +r` are `not a valid
        // identifier` in GNU, so for those two the word falls through
        // as an operand and refuses there.
        for (const ch of expanded.slice(1)) plusChars.add(ch)
      } else {
        operands.push(expanded)
      }
    }
  }
  const cmdWord = keyword === NT.LOCAL ? 'local' : keyword
  const words = operands.filter((operand) => typeof operand === 'string')
  if (session.shellOptions.xtrace === true) {
    // Traced once expanded, before the builtin runs and outside its
    // redirects: each array operand, then the command naming them.
    const staged = operands.filter((op) => typeof op !== 'string')
    context.frame.diagnostics.push(
      concat([
        ...staged.map((op) => traceArray(op.name, op.items, op.append)),
        traceCommand([cmdWord, ...traced]),
      ]),
    )
  }
  if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
    const refused = declareOptionRefusal(cmdWord, flagChars, plusChars)
    if (refused !== null) return refused
  }
  if (
    (flagChars.has('f') || flagChars.has('F')) &&
    (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset')
  ) {
    // `-f`/`-F` select functions, not variables: `-rf` freezes, `-xf`
    // exports, `-f NAME` prints the body, `-F NAME` prints the name, and
    // a missing name is exit 1 without a word.
    return handleDeclareFunctions(cmdWord, session, flagChars, words, plusChars, parser)
  }
  // `-l` and `-u` cannot both hold; a cluster naming both sets neither
  // (pinned: `declare -lu s=aBc` prints `declare -- s`).
  // The value-shaping marks go on or off before a value stores, the rest
  // once it has (`declaredMarks`).
  const marks = declaredMarks(flagChars, plusChars)
  const shaping = marks.filter(([attr]) => SHAPING.has(attr))
  // `-p` prints rather than declares, so it is answered before anything
  // declares (`declare -ap NAME` converts nothing); with no names, an
  // attribute letter lists the names carrying it, `-p` or not.
  const listing =
    operands.length === 0 &&
    [...flagChars].some((c) => LISTED_ATTRIBUTES.has(c) || c === 'a' || c === 'A')
  if (
    (flagChars.has('p') || plusChars.has('p') || listing) &&
    (keyword === 'declare' || keyword === 'typeset')
  ) {
    return handleDeclarePrint(words, session, flagChars)
  }
  const conversionErrors: string[] = []
  const kind = declaredKind(flagChars)
  if (kind !== null && !VISIBLE_SCOPE_BUILTINS.has(keyword)) {
    // `declare -a NAME` / `declare -A NAME` with no value declare an
    // empty array of that kind, so ${#NAME[@]} is 0 and an element
    // write leaves the other slots unassigned. GNU refuses to
    // convert between the two kinds and says so per name while the
    // rest of the operands still declare. `export` and `readonly` leave
    // a bare name's value alone.
    const wantAssoc = kind === VarKind.Assoc
    for (const bare of words) {
      if (bare.includes('=')) continue
      // Both branches below write array storage raw (the top-level
      // one migrates an existing scalar), so a hidden name refuses
      // like any assignment spelling before either lands.
      try {
        ensureVarVisible(session, bare)
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        throw new DiscardSignal(encodeText(`${err.message}\n`))
      }
      const fresh =
        !flagChars.has('g') && session.localVars !== null && !session.localVars.has(bare)
      const heldVar = sessionEntry(session.vars, bare)
      // `handleLocal` refuses a readonly name in its voice.
      if (fresh && heldVar?.attrs.has(VarAttr.Readonly) === true) continue
      // Inside a function the name is a local of the declared kind, a new
      // one starting as `startLocal` leaves it (with `-I`, the value it
      // shadows); `-g` declares at global scope.
      const local = !flagChars.has('g') && noteLocalArray(session, bare)
      if (local && fresh) startLocal(session, bare, flagChars.has('I'))
      const held = heldValue(session, bare)
      const conflict = kindConflict(held, kind)
      if (conflict !== null) {
        conversionErrors.push(`bash: ${cmdWord}: ${bare}: ${conflict}`)
        continue
      }
      const isMap = held !== null && typeof held === 'object' && !Array.isArray(held)
      if (wantAssoc ? isMap : Array.isArray(held)) continue
      // A local of another kind starts empty; at top level an existing
      // scalar becomes element 0, or the value at the literal key "0" (GNU
      // allows scalar-to-associative conversion, unlike indexed).
      const scalar = local ? undefined : conversionScalar(session, bare)
      if (wantAssoc) seedVar(session, bare, scalar === undefined ? {} : { '0': scalar })
      else seedVar(session, bare, scalar === undefined ? [] : [scalar])
    }
  }
  // declare/typeset scope like `local` inside a function (bash
  // semantics) and assign globally at top level, which is exactly
  // handleLocal's fallback when no function scope is active. `-r` rides
  // the same path and lands on what each operand wrote, so
  // `f() { local -r A=(x); }` freezes f's own A, not the caller's.
  if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
    const result = await handleLocal(
      operands,
      session,
      view,
      // `declare`/`typeset` share this handler but have to name
      // themselves in a diagnostic rather than say `local`.
      cmdWord,
      kind,
      shaping,
      marks,
      [...plusChars].sort(compareCodePoints).join(''),
      flagChars.has('n') && !plusChars.has('n'),
      flagChars.has('g'),
      flagChars.has('I'),
    )
    return mergeConversionErrors(result, conversionErrors)
  }
  // Array literals travel as data: the handler stores them through
  // the session view and owns both refusal voices, so the executor
  // only expands and stages. The flags pass through so -p, the bare
  // listing and bad options work.
  const result =
    keyword === 'readonly'
      ? await handleReadonly([...flagWords, ...operands], session, view, kind, parser)
      : await handleExport([...flagWords, ...operands], session, view, parser)
  return mergeConversionErrors(result, conversionErrors)
}
