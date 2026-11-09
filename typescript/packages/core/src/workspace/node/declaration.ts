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
import type { RedirectResult } from '../../context/session_context.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { getDeclarationKeyword, getText } from '../../shell/helpers.ts'
import type { ParseScope } from '../../shell/parse/scope.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { VarAttr } from '../../shell/variable.ts'
import { traceArray, traceCommand } from '../../shell/xtrace.ts'
import { concat } from '../../utils/bytes.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { VISIBLE_SCOPE_BUILTINS } from '../executor/builtins/declare/constants.ts'
import { declared as declaredOn, markNames } from '../executor/builtins/declare/declare.ts'
import type { DeclarationOperand } from '../executor/builtins/declare/types.ts'
import { flagHelp } from '../executor/builtins/help/index.ts'
import { handleDeclareFunctions } from '../executor/builtins/index.ts'
import { builtinUsage, fail } from '../executor/builtins/shared.ts'
import { expandNode } from '../expand/node.ts'
import type { ExecuteFn } from '../expand/types.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { deciding, prefixTemporaries } from '../session/state.ts'
import type { ExpandedWords } from './types.ts'
import { expandArrayItems } from './assignment.ts'

// Every letter GNU's `declare` accepts, so a typo refuses with the usage
// line instead of being silently dropped. `-a`/`-A` are kinds, not
// attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
// /`-I` are modes the handlers read. `-n` stores the reference and every
// reader and writer resolves through it (`deref` in `session/state`).
const DECLARE_LETTERS: ReadonlySet<string> = new Set('aAfFgiIlnprtux')

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
): RedirectResult | null {
  const bad = [...flagChars, ...plusChars]
    .sort(compareCodePoints)
    .find((c) => !DECLARE_LETTERS.has(c))
  if (bad === undefined) return null
  const sign = flagChars.has(bad) ? '-' : '+'
  return fail(cmd, `${shellVoice()}${cmd}: ${sign}${bad}: invalid option\n${builtinUsage(cmd)}`, 2)
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
  expandedWords?: ExpandedWords,
): Promise<RedirectResult> {
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
      const expanded = await expandNode(child, context, executeFn, callStack)
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
      const expanded = await expandNode(child, context, executeFn, callStack)
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
        !VISIBLE_SCOPE_BUILTINS.has(keyword)
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
  if (expandedWords !== undefined) expandedWords.words = [cmdWord, ...traced]
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
  if (traced[0] === '--help') {
    // bash answers `--help` as the first word with the builtin's help,
    // before it reads a single option.
    const answered = flagHelp(cmdWord)
    if (answered !== null) return answered
  }
  if (VISIBLE_SCOPE_BUILTINS.has(keyword)) {
    // Array literals travel as data: the handler stores them through
    // the session view and owns both refusal voices, so the executor
    // only expands and stages. The flags pass through so -p, the bare
    // listing and bad options work.
    const attr = keyword === 'readonly' ? VarAttr.Readonly : VarAttr.Export
    return await markNames([...flagWords, ...operands], context, executeFn, callStack, attr, parser)
  }
  const refused = declareOptionRefusal(cmdWord, flagChars, plusChars)
  if (refused !== null) return refused
  if (flagChars.has('f') || flagChars.has('F')) {
    // `-f`/`-F` select functions, not variables: `-rf` freezes, `-xf`
    // exports, `-f NAME` prints the body, `-F NAME` prints the name, and
    // a missing name is exit 1 without a word.
    return handleDeclareFunctions(cmdWord, session, flagChars, words, plusChars, parser)
  }
  const temporaries = prefixTemporaries(session)
  return declaredOn(
    cmdWord,
    (shell) =>
      shell.declare(
        cmdWord,
        [...flagChars].sort(compareCodePoints).join(''),
        [...plusChars].sort(compareCodePoints).join(''),
        operands,
        temporaries,
        true,
        deciding(),
      ),
    context,
    executeFn,
    callStack,
  )
}
