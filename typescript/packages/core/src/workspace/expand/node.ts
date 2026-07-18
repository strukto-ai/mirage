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

import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { IOResult } from '../../io/types.ts'
import type { Session } from '../session/session.ts'
import { expandTilde } from '../../utils/path.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { shlexSplit } from '../../utils/shlex.ts'
import { evaluateArith } from '../../shell/arith.ts'
import { ArithError } from '../../shell/errors.ts'
import { ARITH_DELIMITERS, ARITH_OPERATORS } from './constants.ts'
import { expandBraces, lookupVar, type TSNodeLike } from './variable.ts'

export type ExecuteFn = (command: string, opts: { sessionId: string }) => Promise<IOResult>

function unescapeUnquoted(text: string): string {
  if (!text.includes('\\')) return text
  const parts = shlexSplit(text)
  return parts[0] ?? text
}

// Reconstruct arithmetic expression text for the shared evaluator.
// `$`-expansions substitute textually (bash performs expansions before
// arithmetic evaluation), while bare variable names stay as names so the
// evaluator can resolve and assign them (`$(( y = 3 ))` needs `y`, not
// its value).
export async function expandArith(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string> {
  const parts: string[] = []
  for (const child of tsNode.children) {
    if (ARITH_DELIMITERS.has(child.type)) continue
    if (
      child.type === NT.BINARY_EXPRESSION ||
      child.type === NT.UNARY_EXPRESSION ||
      child.type === NT.PARENTHESIZED_EXPRESSION ||
      child.type === NT.TERNARY_EXPRESSION ||
      child.type === NT.POSTFIX_EXPRESSION
    ) {
      parts.push(await expandArith(child, session, executeFn, callStack))
    } else if (ARITH_OPERATORS.has(child.type)) {
      parts.push(child.text)
    } else if (child.type === NT.NUMBER) {
      parts.push(child.text)
    } else if (
      child.type === NT.SIMPLE_EXPANSION ||
      child.type === NT.EXPANSION ||
      child.type === NT.COMMAND_SUBSTITUTION
    ) {
      parts.push(await expandNode(child, session, executeFn, callStack))
    } else if (child.type === NT.VARIABLE_NAME) {
      parts.push(child.text)
    } else {
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
  }
  return parts.join(' ')
}

export async function expandNode(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string> {
  const ntype = tsNode.type

  if (ntype === NT.WORD) return expandTilde(unescapeUnquoted(tsNode.text), homeDir(session))
  if (ntype === NT.NUMBER) return tsNode.text
  if (ntype === NT.COMMAND_NAME) {
    // The name is a word like any other: $CMD, "quoted", $(sub) all
    // expand. A bare word has one named child (or none) and falls
    // through to its own expansion rule.
    const child = tsNode.namedChildren[0]
    if (child !== undefined) return expandNode(child, session, executeFn, callStack)
    return tsNode.text
  }

  if (ntype === NT.SIMPLE_EXPANSION) {
    const raw = tsNode.text
    const special = tsNode.namedChildren.find((c) => c.type === NT.SPECIAL_VARIABLE_NAME)
    if (special !== undefined) {
      // lastIndexOf would split `$$` into prefix "$" + variable "".
      return lookupVar(special.text, session, callStack)
    }
    const dollar = raw.lastIndexOf('$')
    const prefix = raw.slice(0, dollar)
    const variable = raw.slice(dollar + 1)
    return prefix + lookupVar(variable, session, callStack)
  }

  if (ntype === NT.EXPANSION) {
    return expandBraces(tsNode, session.env, callStack, session.arrays)
  }

  if (ntype === NT.COMMAND_SUBSTITUTION) {
    const innerCmds = tsNode.namedChildren.filter(
      (c) =>
        c.type === NT.COMMAND ||
        c.type === NT.PIPELINE ||
        c.type === NT.LIST ||
        c.type === NT.REDIRECTED_STATEMENT ||
        c.type === NT.SUBSHELL,
    )
    if (innerCmds.length === 0) return ''
    const inner = innerCmds[0]?.text ?? ''
    const io = await executeFn(inner, { sessionId: session.sessionId })
    return (await io.stdoutStr()).replace(/\n+$/, '')
  }

  if (ntype === NT.ARITHMETIC_EXPANSION) {
    const expr = await expandArith(tsNode, session, executeFn, callStack)
    let value: bigint
    let updates: Record<string, string>
    try {
      ;({ value, updates } = evaluateArith(expr, session.env))
    } catch (err) {
      if (err instanceof ArithError) return tsNode.text
      throw err
    }
    Object.assign(session.env, updates)
    return value.toString()
  }

  if (ntype === NT.CONCATENATION) {
    const parts: string[] = []
    for (const child of tsNode.children) {
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
    return parts.join('')
  }

  if (ntype === NT.STRING) {
    const parts: string[] = []
    for (const child of tsNode.children) {
      if (child.type === NT.DQUOTE) continue
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
    return parts.join('')
  }

  if (ntype === NT.STRING_CONTENT) {
    const NUL = String.fromCharCode(0)
    let text = tsNode.text
    text = text.replaceAll('\\\\', NUL)
    text = text.replaceAll('\\"', '"')
    text = text.replaceAll('\\$', '$')
    text = text.replaceAll('\\`', '`')
    text = text.replaceAll('\\\n', '')
    text = text.replaceAll(NUL, '\\')
    return text
  }

  if (ntype === NT.RAW_STRING) {
    const raw = tsNode.text
    return raw.slice(1, -1)
  }

  if (ntype === NT.VARIABLE_ASSIGNMENT) {
    const raw = tsNode.text
    if (raw.includes('=')) {
      const eq = raw.indexOf('=')
      const key = raw.slice(0, eq)
      const valPart = raw.slice(eq + 1)
      const valNodes = tsNode.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
      if (valNodes.length > 0 && valNodes[0] !== undefined) {
        const expanded = await expandNode(valNodes[0], session, executeFn, callStack)
        return `${key}=${expanded}`
      }
      return `${key}=${valPart}`
    }
    return raw
  }

  return tsNode.text
}
