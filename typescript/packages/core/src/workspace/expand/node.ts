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
import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import type { Session } from '../session/session.ts'
import { randomReader, sessionElements, visibleEnv } from '../session/state.ts'
import { markEscapedGlobs, markGlobs, unmarkGlobs } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { evaluateArith } from '../../shell/arith.ts'
import { splitBacktickRegion } from '../../shell/backticks.ts'
import { ArithError, ExitSignal } from '../../shell/errors.ts'
import { decodeAnsiC, unescapeDquoted, unescapeUnquoted } from '../../shell/escapes.ts'
import { ARITH_DELIMITERS, ARITH_OPERATORS } from './constants.ts'
import { expandBraces, landArithWrites, lookupVar } from './variable.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import type { HandOff } from '../../policy/types.ts'

/**
 * The executor's door for a nested line. `node` is the node whose text
 * the line is: the command running it (bound by the dispatcher for
 * every word that runs a line) or the substitution being expanded,
 * which names itself. The inner line's commands stand under it, where
 * the judging pass placed them. `handed` is the hand-off of the subtree
 * that runs the evaluation, bound by the walker (`withHandOff`): the
 * line's own for a command in the foreground, a job's own for a command
 * inside a background job. The inner line runs on a hand-off made under
 * it, so a line a job evaluates after the typed line has ended still
 * stands under the hand-off holding the job's grants.
 */
export type ExecuteFn = (
  command: string,
  opts: {
    sessionId: string
    stdin?: ByteSource | null
    node?: TSNodeLike
    span?: readonly [number, number]
    handed?: HandOff
  },
) => Promise<IOResult>

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

/**
 * Expand a backtick region, one nested line per pair. `offset` is where
 * `raw` (the region's text, the folded prefix stripped) starts in the
 * node's text.
 */
async function expandBacktickRegion(
  raw: string,
  session: Session,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  offset: number,
): Promise<string> {
  let out = ''
  for (const segment of splitBacktickRegion(raw)) {
    if (!segment.command) {
      out += segment.text
      continue
    }
    // Each pair is its own place on the line: the node holds every
    // touching pair, so the span within it says which one runs.
    const io = await childLine(session, executeFn, segment.text, node, [
      offset + segment.start,
      offset + segment.end,
    ])
    out += (await io.stdoutStr()).replace(/\n+$/, '')
    session.diagnostics.push(await io.materializeStderr())
    session.cmdsubSeq += 1
    session.cmdsubStatus = io.exitCode
  }
  return out
}

// Unquoted-heredoc escapes: \$, \`, \\, \<newline> only.
// Unlike double quotes, \" stays literal in heredoc bodies.
/**
 * Run a substitution's line in a child shell.
 *
 * bash forks for `$(...)` and backticks, so what the line assigns, `cd`s
 * or seeds (`RANDOM`) never reaches the parent: the session is restored
 * around the run, as `handleSubshell` restores it around a `( )` body.
 * The line reaches the executor unwrapped, under the node that named it,
 * so the pass places its commands where they were typed rather than
 * under a subshell of their own. `span` is the pair's span within the
 * node, for a backtick region holding several.
 */
async function childLine(
  session: Session,
  executeFn: ExecuteFn,
  text: string,
  node: TSNodeLike,
  span?: [number, number],
): Promise<IOResult> {
  const saved = session.snapshot()
  try {
    return await executeFn(text, {
      sessionId: session.sessionId,
      node,
      ...(span === undefined ? {} : { span }),
    })
  } finally {
    session.restore(saved)
  }
}

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
  view?: SessionView,
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
    out += await expandNode(c, session, executeFn, callStack, view)
    pos = c.endIndex - base
  }
  return out + text.slice(pos)
}

// Reconstruct arithmetic expression text for the shared evaluator.
// `$`-expansions substitute textually (bash performs expansions before
// arithmetic evaluation), while bare variable names stay as names so the
// evaluator can resolve and assign them (`$(( y = 3 ))` needs `y`, not
// its value).
/**
 * The fatal shape of an arithmetic expansion error.
 *
 * bash aborts the whole line on a bad `$((...))` in a non-interactive
 * shell, exactly as it does for `${var:?}`: the command never runs, the
 * line exits 1, and a subshell or pipeline segment containing it reports
 * 1. The old return of the expansion's own text printed `$((1/0))` with
 * exit 0, the silent wrong answer the fail-loud rule forbids. The
 * diagnostic is the expression as typed, trimmed, in the house style that
 * drops bash's `line N:` prefix and its `(error token is ...)` suffix, the
 * same shape `(( ))` reports.
 */
export function arithExit(expr: string, err: ArithError): ExitSignal {
  return new ExitSignal(
    1,
    new TextEncoder().encode(`bash: ${expr.trim()}: ${err.message}\n`),
    null,
    1,
  )
}

export async function expandArith(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string> {
  const parts: string[] = []
  const base = tsNode.startIndex ?? 0
  let end = 0
  for (const child of tsNode.children) {
    const start = (child.startIndex ?? base + end) - base
    parts.push(tsNode.text.slice(end, start))
    end = (child.endIndex ?? base + start + child.text.length) - base
    if (ARITH_DELIMITERS.has(child.type)) continue
    if (
      child.type === NT.BINARY_EXPRESSION ||
      child.type === NT.UNARY_EXPRESSION ||
      child.type === NT.PARENTHESIZED_EXPRESSION ||
      child.type === NT.TERNARY_EXPRESSION ||
      child.type === NT.POSTFIX_EXPRESSION
    ) {
      parts.push(await expandArith(child, session, executeFn, callStack, view))
    } else if (child.type === 'subscript') {
      parts.push(await arithSubscript(child, session, executeFn, callStack, view))
    } else if (ARITH_OPERATORS.has(child.type)) {
      parts.push(child.text)
    } else if (child.type === NT.NUMBER) {
      parts.push(child.text)
    } else if (
      child.type === NT.SIMPLE_EXPANSION ||
      child.type === NT.EXPANSION ||
      child.type === NT.COMMAND_SUBSTITUTION
    ) {
      parts.push(await expandNode(child, session, executeFn, callStack, view))
    } else if (child.type === NT.VARIABLE_NAME) {
      parts.push(child.text)
    } else {
      parts.push(await expandNode(child, session, executeFn, callStack, view))
    }
  }
  parts.push(tsNode.text.slice(end))
  return parts.join('').trim()
}

/**
 * Reconstruct one element reference for the arithmetic tokenizer.
 *
 * The subscript's `$`-expansions substitute here, since bash expands
 * the whole expression text before evaluating it, while a literal
 * interior rides verbatim: for an associative array the text *is* the
 * key (`m[k]` reads the key `k` even when a variable `k` exists), and
 * for an indexed one the evaluator's resolver still gets the
 * arithmetic spelling.
 */
async function arithSubscript(
  subNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string> {
  let name = ''
  const inner: TSNodeLike[] = []
  for (const sc of subNode.namedChildren) {
    if (sc.type === NT.VARIABLE_NAME && name === '') {
      name = sc.text
    } else {
      inner.push(sc)
    }
  }
  const raw = subNode.text.slice(name.length + 1, -1)
  if (!/[$'"`]/.test(raw)) return `${name}[${raw}]`
  const parts: string[] = []
  for (const sc of inner) {
    if (
      sc.type === NT.SIMPLE_EXPANSION ||
      sc.type === NT.EXPANSION ||
      sc.type === NT.COMMAND_SUBSTITUTION ||
      sc.type === NT.STRING ||
      sc.type === NT.RAW_STRING ||
      sc.type === NT.ANSI_C_STRING ||
      sc.type === NT.TRANSLATED_STRING ||
      sc.type === NT.CONCATENATION
    ) {
      parts.push(await expandNode(sc, session, executeFn, callStack, view))
    } else {
      parts.push(sc.text)
    }
  }
  return `${name}[${parts.join('')}]`
}

// Expand a tree-sitter node to the string it stands for.
export async function expandNode(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string> {
  return unmarkGlobs(await expandNodeMarked(tsNode, session, executeFn, callStack, view))
}

/**
 * Expand a node, marking the glob characters quoting made literal.
 *
 * Same string as `expandNode`, except that a glob character quoting
 * neutralized travels under its own mark. Only pathname
 * expansion cares, so this is what `expandWords` reads while every other
 * caller takes the unmarked wrapper above.
 */
export async function expandNodeMarked(
  tsNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string> {
  const ntype = tsNode.type

  if (ntype === NT.WORD) {
    return expandTilde(unescapeUnquoted(markEscapedGlobs(tsNode.text)), homeDir(session))
  }
  if (ntype === NT.NUMBER) return tsNode.text
  if (ntype === NT.COMMAND_NAME) {
    // The name is a word like any other: $CMD, "quoted", $(sub) all
    // expand. A bare word has one named child (or none) and falls
    // through to its own expansion rule.
    const child = tsNode.namedChildren[0]
    if (child !== undefined) return expandNodeMarked(child, session, executeFn, callStack, view)
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
      expandNode(c, session, executeFn, callStack, view)
    return prefix + (await expandBraces(tsNode, session, callStack, expandChild, view))
  }

  if (ntype === NT.COMMAND_SUBSTITUTION) {
    const prefix = foldedWhitespace(tsNode)
    const rawSub = tsNode.text.slice(prefix.length)
    if (rawSub.startsWith('`') && rawSub.endsWith('`')) {
      // Backtick regions are re-lexed here rather than trusted from the
      // grammar, which merges adjacent pairs (see splitBacktickRegion).
      return (
        prefix + (await expandBacktickRegion(rawSub, session, executeFn, tsNode, prefix.length))
      )
    }
    if (rawSub.startsWith('$((') && rawSub.endsWith('))')) {
      // Inside heredoc bodies tree-sitter parses `$((expr))` as a
      // command substitution wrapping a subshell; evaluate it as
      // arithmetic (python mirrors via a reparse; here the expression
      // text is reconstructed with `$`-refs substituted).
      const sub = tsNode.namedChildren
      const only = sub[0]
      if (sub.length === 1 && only?.type === NT.SUBSHELL) {
        const parenExpr = await substituteDollarRefs(only, session, executeFn, callStack, view)
        const expr = parenExpr.slice(1, -1)
        let arith: ArithResult
        const reader = randomReader(session)
        try {
          // Reads resolve against the visible env, so a hidden name
          // counts as unset; the write-back below lands on the raw env
          // (policy-ungated until expansion goes async), with the
          // hidden gate applied inside expansionWrite.
          arith = evaluateArith(
            expr,
            visibleEnv(session),
            0,
            sessionElements(session, reader),
            reader.read,
            reader.wrote,
          )
        } catch (err) {
          if (!(err instanceof ArithError)) throw err
          // bash bound the assignments made before the error, RANDOM's
          // seed included; they land before the line dies.
          await landArithWrites(session, view, err.writes, reader)
          throw arithExit(expr, err)
        }
        await landArithWrites(session, view, arith.writes, reader)
        return prefix + arith.value.toString()
      }
    }
    // The whole body goes to the evaluator: bash substitutes the full
    // statement list, and picking child nodes dropped every statement
    // after a `;` and every non-command statement (declarations,
    // assignments, control flow).
    const inner = rawSub.slice(2, -1)
    if (inner.trim() === '') return prefix
    // The substitution names its own node: the nested line's commands
    // stand under it, which is where the pass placed them.
    const io = await childLine(session, executeFn, inner, tsNode)
    const text = (await io.stdoutStr()).replace(/\n+$/, '')
    // Record the substitution's status: an assignment-only statement
    // whose value ran substitutions reports the last one's status as
    // its own (see assignmentStatus).
    session.diagnostics.push(await io.materializeStderr())
    session.cmdsubSeq += 1
    session.cmdsubStatus = io.exitCode
    return prefix + text
  }

  if (ntype === NT.ARITHMETIC_EXPANSION) {
    const prefix = foldedWhitespace(tsNode)
    const expr = await expandArith(tsNode, session, executeFn, callStack, view)
    let result: ArithResult
    const reader = randomReader(session)
    try {
      result = evaluateArith(
        expr,
        visibleEnv(session),
        0,
        sessionElements(session, reader),
        reader.read,
        reader.wrote,
      )
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      await landArithWrites(session, view, err.writes, reader)
      throw arithExit(expr, err)
    }
    await landArithWrites(session, view, result.writes, reader)
    return prefix + result.value.toString()
  }

  if (ntype === NT.CONCATENATION) {
    // Each piece carries its own quoting, which is the whole reason
    // marks are per character: `'*'?.txt` joins a marked star to a live
    // question mark and still globs, on the `?` alone. A $"..." arrives
    // as an anonymous `$` token followed by the string node; the `$` is
    // the translation marker, not text. A bare trailing `$` (a$) has no
    // string after it and stays literal.
    const parts: string[] = []
    const children = tsNode.children
    for (let position = 0; position < children.length; position += 1) {
      const child = children[position]
      if (child === undefined) continue
      if (child.type === '$' && children[position + 1]?.type === NT.STRING) continue
      parts.push(await expandNodeMarked(child, session, executeFn, callStack, view))
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
      parts.push(await expandNode(child, session, executeFn, callStack, view))
    }
    // Everything the quotes enclose is literal, the text and any value
    // expanded inside it alike: "$p"?.txt globs on the `?` while
    // $p?.txt globs on whatever `p` holds too.
    return markGlobs(parts.join(''))
  }

  if (ntype === NT.STRING_CONTENT) {
    return unescapeDquoted(tsNode.text)
  }

  if (ntype === NT.RAW_STRING) {
    const raw = tsNode.text
    return markGlobs(raw.slice(1, -1))
  }

  if (ntype === NT.ANSI_C_STRING) {
    const raw = tsNode.text
    return markGlobs(decodeAnsiC(raw.slice(2, -1)))
  }

  if (ntype === NT.TRANSLATED_STRING) {
    // $"..." asks for a locale translation; no message catalog is ever
    // loaded, so the translation is the identity and the word keeps
    // plain double-quote semantics.
    for (const child of tsNode.namedChildren) {
      if (child.type === NT.STRING) {
        return expandNodeMarked(child, session, executeFn, callStack, view)
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
        const expanded = await expandNode(valNodes[0], session, executeFn, callStack, view)
        return `${key}=${expanded}`
      }
      return `${key}=${valPart}`
    }
    return raw
  }

  return tsNode.text
}
