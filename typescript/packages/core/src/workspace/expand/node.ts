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
import type { ByteSource, IOResult } from '../../io/types.ts'
import type { Session } from '../session/session.ts'
import { expandTilde } from '../../utils/path.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { shlexSplit } from '../../utils/shlex.ts'
import { evaluateArith } from '../../shell/arith.ts'
import { ArithError } from '../../shell/errors.ts'
import { decodeAnsiC } from '../../shell/escapes.ts'
import { ARITH_DELIMITERS, ARITH_OPERATORS } from './constants.ts'
import { expandBraces, lookupVar } from './variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'

export type ExecuteFn = (
  command: string,
  opts: { sessionId: string; stdin?: ByteSource | null },
) => Promise<IOResult>

export function unescapeUnquoted(text: string): string {
  if (!text.includes('\\')) return text
  const parts = shlexSplit(text)
  return parts[0] ?? text
}

// Whitespace tree-sitter folds into an expansion's opening token.
// Inside a double-quoted string, a run of whitespace between two
// expansions is not emitted as string content: it lands inside the
// following node's extent, so `"$a $(b)"` yields a command substitution
// whose text is `" $(b)"`. Every expansion branch has to re-emit it or
// the two values run together. Unquoted words do not fold, so the
// prefix is empty there and this stays a no-op.
export function foldedWhitespace(node: TSNodeLike): string {
  const raw = node.text
  return raw.slice(0, raw.length - raw.trimStart().length)
}

// Split a backtick region into segments, each flagged as a command or as
// literal text. tree-sitter-bash lexes the gap between two backtick
// substitutions as a single token when that gap is empty or
// whitespace-only, so `a` `b` arrives as ONE command_substitution node
// holding both commands and the text between them. Re-lexing the node's
// own text on unescaped backticks recovers the real segments; a single
// pair simply yields one command segment.
//
// Inside a command, POSIX keeps the backslash literal except before `$`,
// a backtick and `\`, where it escapes. Consuming those pairs whole is
// what makes the parity right: `\\` is one escaped backslash, so a
// backtick straight after it still closes the region rather than reading
// as an escaped backtick.
function splitBacktickSegments(raw: string): [string, boolean][] {
  const segments: [string, boolean][] = []
  const ESCAPABLE = new Set(['$', '`', '\\'])
  let buf = ''
  let inCommand = false
  let i = 0
  while (i < raw.length) {
    const next = raw[i + 1]
    if (raw[i] === '\\' && inCommand && next !== undefined && ESCAPABLE.has(next)) {
      buf += next
      i += 2
      continue
    }
    if (raw[i] === '`') {
      segments.push([buf, inCommand])
      buf = ''
      inCommand = !inCommand
      i += 1
      continue
    }
    buf += raw.charAt(i)
    i += 1
  }
  segments.push([buf, inCommand])
  return segments.filter(([text, cmd]) => text !== '' || cmd)
}

async function expandBacktickRegion(
  raw: string,
  session: Session,
  executeFn: ExecuteFn,
): Promise<string> {
  let out = ''
  for (const [text, isCommand] of splitBacktickSegments(raw)) {
    if (!isCommand) {
      out += text
      continue
    }
    const io = await executeFn(text, { sessionId: session.sessionId })
    out += (await io.stdoutStr()).replace(/\n+$/, '')
    io.syncExitCode()
    session.cmdsubSeq += 1
    session.cmdsubStatus = io.exitCode
  }
  return out
}

// Unquoted-heredoc escapes: \$, \`, \\, \<newline> only.
// Unlike double quotes, \" stays literal in heredoc bodies.
export function unescapeHeredoc(text: string): string {
  if (!text.includes('\\')) return text
  const NUL = String.fromCharCode(0)
  let out = text
  out = out.replaceAll('\\\\', NUL)
  out = out.replaceAll('\\$', '$')
  out = out.replaceAll('\\`', '`')
  out = out.replaceAll('\\\n', '')
  return out.replaceAll(NUL, '\\')
}

const DOLLAR_NODE_TYPES: ReadonlySet<string> = new Set([
  NT.SIMPLE_EXPANSION,
  NT.EXPANSION,
  NT.COMMAND_SUBSTITUTION,
  NT.ARITHMETIC_EXPANSION,
])

function collectDollarNodes(node: TSNodeLike, acc: TSNodeLike[]): void {
  for (const c of node.namedChildren) {
    if (DOLLAR_NODE_TYPES.has(c.type)) acc.push(c)
    else collectDollarNodes(c, acc)
  }
}

// Textually substitute `$`-expansions inside a node, keeping all other
// source text verbatim (gap-filled from spans). Used to reconstruct
// arithmetic expression text when tree-sitter parses `$((expr))` as a
// command substitution (heredoc bodies do this).
async function substituteDollarRefs(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string> {
  const acc: TSNodeLike[] = []
  collectDollarNodes(node, acc)
  const base = node.startIndex ?? 0
  const text = node.text
  let out = ''
  let pos = 0
  for (const c of acc) {
    if (c.startIndex === undefined || c.endIndex === undefined) continue
    out += text.slice(pos, c.startIndex - base)
    out += await expandNode(c, session, executeFn, callStack)
    pos = c.endIndex - base
  }
  return out + text.slice(pos)
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
    const prefix = foldedWhitespace(tsNode)
    const raw = tsNode.text.slice(prefix.length)
    const special = tsNode.namedChildren.find((c) => c.type === NT.SPECIAL_VARIABLE_NAME)
    if (special !== undefined) {
      return prefix + lookupVar(special.text, session, callStack)
    }
    // Slice past the leading "$" rather than searching for it, so `$$`
    // keeps its name instead of splitting into prefix + "".
    return prefix + lookupVar(raw.slice(1), session, callStack)
  }

  if (ntype === NT.EXPANSION) {
    const prefix = foldedWhitespace(tsNode)
    const expandChild = (c: TSNodeLike): Promise<string> =>
      expandNode(c, session, executeFn, callStack)
    return prefix + (await expandBraces(tsNode, session, callStack, expandChild))
  }

  if (ntype === NT.COMMAND_SUBSTITUTION) {
    const prefix = foldedWhitespace(tsNode)
    const rawSub = tsNode.text.slice(prefix.length)
    if (rawSub.startsWith('`') && rawSub.endsWith('`')) {
      // Backtick regions are re-lexed here rather than trusted from the
      // grammar, which merges adjacent pairs (see splitBacktickSegments).
      return prefix + (await expandBacktickRegion(rawSub, session, executeFn))
    }
    if (rawSub.startsWith('$((') && rawSub.endsWith('))')) {
      // Inside heredoc bodies tree-sitter parses `$((expr))` as a
      // command substitution wrapping a subshell; evaluate it as
      // arithmetic (python mirrors via a reparse; here the expression
      // text is reconstructed with `$`-refs substituted).
      const sub = tsNode.namedChildren
      const only = sub[0]
      if (sub.length === 1 && only?.type === NT.SUBSHELL) {
        const parenExpr = await substituteDollarRefs(only, session, executeFn, callStack)
        const expr = parenExpr.slice(1, -1)
        try {
          const { value, updates } = evaluateArith(expr, session.env)
          Object.assign(session.env, updates)
          return prefix + value.toString()
        } catch (err) {
          if (!(err instanceof ArithError)) throw err
          return prefix + rawSub
        }
      }
    }
    const innerCmds = tsNode.namedChildren.filter(
      (c) =>
        c.type === NT.COMMAND ||
        c.type === NT.PIPELINE ||
        c.type === NT.LIST ||
        c.type === NT.REDIRECTED_STATEMENT ||
        c.type === NT.SUBSHELL,
    )
    if (innerCmds.length === 0) return prefix
    const inner = innerCmds[0]?.text ?? ''
    const io = await executeFn(inner, { sessionId: session.sessionId })
    const text = (await io.stdoutStr()).replace(/\n+$/, '')
    // Record the substitution's status: an assignment-only statement
    // whose value ran substitutions reports the last one's status as
    // its own (see assignmentStatus).
    io.syncExitCode()
    session.cmdsubSeq += 1
    session.cmdsubStatus = io.exitCode
    return prefix + text
  }

  if (ntype === NT.ARITHMETIC_EXPANSION) {
    const prefix = foldedWhitespace(tsNode)
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
    return prefix + value.toString()
  }

  if (ntype === NT.CONCATENATION) {
    const parts: string[] = []
    const children = tsNode.children
    for (let position = 0; position < children.length; position += 1) {
      const child = children[position]
      if (child === undefined) continue
      // A $"..." in a concatenation arrives as an anonymous `$` token
      // followed by the string node; the `$` is the translation
      // marker, not text. A bare trailing `$` (a$) has no string after
      // it and stays literal.
      if (child.type === '$' && children[position + 1]?.type === NT.STRING) {
        continue
      }
      parts.push(await expandNode(child, session, executeFn, callStack))
    }
    return parts.join('')
  }

  if (ntype === NT.STRING) {
    // The newline bytes of a multi-line string belong to no child token,
    // so each row step re-emits them; the quote tokens anchor the count,
    // which keeps leading, trailing and blank lines alive ("a\n\nb" is
    // five bytes in bash).
    const parts: string[] = []
    let prevEndRow: number | null = null
    for (const child of tsNode.children) {
      if (prevEndRow !== null) {
        parts.push('\n'.repeat(Math.max(0, (child.startPosition?.row ?? 0) - prevEndRow)))
      }
      prevEndRow = child.endPosition?.row ?? 0
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

  if (ntype === NT.ANSI_C_STRING) {
    const raw = tsNode.text
    return decodeAnsiC(raw.slice(2, -1))
  }

  if (ntype === NT.TRANSLATED_STRING) {
    // $"..." asks for a locale translation; no message catalog is ever
    // loaded, so the translation is the identity and the word keeps
    // plain double-quote semantics.
    for (const child of tsNode.namedChildren) {
      if (child.type === NT.STRING) {
        return expandNode(child, session, executeFn, callStack)
      }
    }
    return ''
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
