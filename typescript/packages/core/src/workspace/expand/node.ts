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
import type { SessionView } from '../../ops/types.ts'
import { CallStack } from '../../shell/call_stack.ts'
import type { JobConsole } from '../../shell/console/index.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { quotedParts } from '../../shell/helpers.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import type { SessionState } from '../session/session.ts'
import { randomReader, sessionElements, visibleEnv } from '../session/state.ts'
import { markEscapedGlobs, markGlobs, unmarkGlobs } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { evaluateArith } from '../../shell/arith.ts'
import { splitBacktickRegion } from '../../shell/backticks.ts'
import { ArithError, BadSubstitution, DiscardSignal, named } from '../../shell/errors.ts'
import { decodeAnsiC, unescapeDquoted, unescapeUnquoted } from '../../shell/escapes.ts'
import { ARITH_DELIMITERS, ARITH_OPERATORS } from './constants.ts'
import { scanParameter } from '../../shell/parameter.ts'
import { joinChunks, valuePiece } from './fields.ts'
import { type Chunk, piece } from './types.ts'
import { expandBraces, isAtSplat, landArithWrites, parameterChunks } from './variable.ts'
import type { ArithResult, TSNodeLike } from '../../shell/types.ts'
import type { HandOff } from '../../policy/types.ts'
import type { ExecutionScope } from '../execution.ts'
import { decodeText, encodeText } from '../../shell/bytes.ts'

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
    executionScope?: ExecutionScope
    context?: EvaluationContext
    session?: SessionState
    stdin?: ByteSource | null
    signal?: AbortSignal
    node?: TSNodeLike
    span?: readonly [number, number]
    handed?: HandOff
    substitution?: boolean
    sink?: JobConsole
    callStack?: CallStack
    jobTable?: JobTable
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
  context: EvaluationContext,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  offset: number,
  callStack: CallStack | null,
): Promise<string> {
  let out = ''
  for (const segment of splitBacktickRegion(raw)) {
    if (!segment.command) {
      out += segment.text
      continue
    }
    // Each pair is its own place on the line: the node holds every
    // touching pair, so the span within it says which one runs.
    const io = await childLine(context, executeFn, segment.text, node, callStack, [
      offset + segment.start,
      offset + segment.end,
    ])
    out += decodeText(await io.materializeStdout()).replace(/\n+$/, '')
    context.frame.diagnostics.push(await io.materializeStderr())
    context.frame.cmdsubSeq += 1
    context.frame.cmdsubStatus = io.exitCode
  }
  return out
}

// Unquoted-heredoc escapes: \$, \`, \\, \<newline> only.
// Unlike double quotes, \" stays literal in heredoc bodies.
/**
 * Run a substitution's line in a child shell.
 *
 * The evaluator isolates the child shell, except for Bash's `$(< file)`
 * optimization, whose filename expands in the parent. It decides from
 * a fresh parse of the body, including each pair in a backtick region.
 * The line reaches the executor unwrapped, under the node that named it,
 * so the pass places its commands where they were typed rather than
 * under a subshell of their own. The child runs on a copy of the caller's
 * frames: inside a function it reads the function's `$1`, `return` ends it,
 * and so does a `break` from a loop the caller is in. `span` is the pair's
 * span within the node, for a backtick region holding several.
 */
export async function childLine(
  context: EvaluationContext,
  executeFn: ExecuteFn,
  text: string,
  node: TSNodeLike,
  callStack: CallStack | null,
  span?: [number, number],
): Promise<IOResult> {
  const session = context.session
  return executeFn(text, {
    sessionId: session.sessionId,
    context,
    node,
    substitution: true,
    callStack: (callStack ?? new CallStack()).fork(),
    ...(span === undefined ? {} : { span }),
  })
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
  context: EvaluationContext,
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
    out += await expandNode(c, context, executeFn, callStack, view)
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
 * bash discards the rest of the line on a bad `$((...))`: the command
 * never runs, `$?` is 1, and a subshell or pipeline segment containing it
 * reports 1. The old return of the expansion's own text printed `$((1/0))` with
 * exit 0, the silent wrong answer the fail-loud rule forbids. The
 * diagnostic is the expression as typed, trimmed, in the house style that
 * drops bash's `line N:` prefix and its `(error token is ...)` suffix, the
 * same shape `(( ))` reports.
 */
export function arithExit(expr: string, err: ArithError): DiscardSignal {
  return new DiscardSignal(encodeText(`bash: ${expr.trim()}: ${err.message}\n`))
}

/**
 * Reconstruct arithmetic expression text for the shared evaluator. A bad
 * substitution names the expression as written.
 */
export async function expandArith(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string> {
  return named(arithInside(tsNode), arithText(tsNode, context, executeFn, callStack, view))
}

function arithInside(tsNode: TSNodeLike): string {
  const text = tsNode.text.trimStart()
  for (const [opener, closer] of [
    ['$((', '))'],
    ['((', '))'],
    ['$[', ']'],
  ] as const) {
    if (text.startsWith(opener) && text.endsWith(closer))
      return text.slice(opener.length, -closer.length)
  }
  return text
}

async function arithText(
  tsNode: TSNodeLike,
  context: EvaluationContext,
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
      parts.push(await arithText(child, context, executeFn, callStack, view))
    } else if (child.type === 'subscript') {
      parts.push(await arithSubscript(child, context, executeFn, callStack, view))
    } else if (ARITH_OPERATORS.has(child.type)) {
      parts.push(child.text)
    } else if (child.type === NT.NUMBER) {
      parts.push(child.text)
    } else if (
      child.type === NT.SIMPLE_EXPANSION ||
      child.type === NT.EXPANSION ||
      child.type === NT.COMMAND_SUBSTITUTION
    ) {
      parts.push(await expandNode(child, context, executeFn, callStack, view))
    } else if (child.type === NT.VARIABLE_NAME) {
      parts.push(child.text)
    } else {
      parts.push(await expandNode(child, context, executeFn, callStack, view))
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
  context: EvaluationContext,
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
      parts.push(await expandNode(sc, context, executeFn, callStack, view))
    } else {
      parts.push(sc.text)
    }
  }
  return `${name}[${parts.join('')}]`
}

// Expand a tree-sitter node to the string it stands for.
export async function expandNode(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string> {
  return unmarkGlobs(await expandNodeMarked(tsNode, context, executeFn, callStack, view))
}

/**
 * Expand a node, marking the glob characters quoting made literal.
 *
 * Same string as `expandNode`, except that a glob character quoting
 * neutralized travels under its own mark. The node is read where no
 * field splitting happens, so a splat reads as its elements joined
 * (`$@` on a space, `$*` on IFS's first character).
 */
export async function expandNodeMarked(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string> {
  return joinChunks(await expandChunks(tsNode, context, executeFn, callStack, view))
}

/**
 * Expand a node to the pieces field splitting reads.
 *
 * What an unquoted expansion produces splits on IFS, and what quoting
 * protects does not; a splat's elements are separate fields.
 * `splitFields` turns the pieces into words and `joinChunks` into the
 * one string a context without splitting reads. `quoted` says whether
 * the node sits inside double quotes. A bad substitution leaving it is
 * renamed after the node, unless a boundary inside named it for good.
 */
export async function expandChunks(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
  quoted = false,
): Promise<Chunk[]> {
  try {
    return await nodeChunks(tsNode, context, executeFn, callStack, view, quoted)
  } catch (err) {
    if (err instanceof BadSubstitution) throw err.within(tsNode.text.trimStart())
    throw err
  }
}

async function nodeChunks(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view: SessionView | undefined,
  quoted: boolean,
): Promise<Chunk[]> {
  const session = context.session
  const ntype = tsNode.type

  if (ntype === NT.WORD) {
    return [piece(expandTilde(unescapeUnquoted(markEscapedGlobs(tsNode.text)), homeDir(session)))]
  }
  if (ntype === NT.COMMAND_NAME) {
    // The name is a word like any other: $CMD, "quoted", $(sub) all
    // expand. A bare word has one named child (or none) and falls
    // through to its own expansion rule.
    const child = tsNode.namedChildren[0]
    if (child !== undefined) return expandChunks(child, context, executeFn, callStack, view)
    return [piece(tsNode.text)]
  }

  if (ntype === NT.SIMPLE_EXPANSION) {
    const prefix = foldedWhitespace(tsNode)
    const raw = tsNode.text.slice(prefix.length)
    const lead = prefix !== '' ? [piece(prefix)] : []
    const ref = scanParameter(raw, 0)
    if (ref === null) return [...lead, piece(quoted ? markGlobs(raw) : raw)]
    const [name, end] = ref
    const tail = raw.slice(end)
    return [
      ...lead,
      ...parameterChunks(name, session, callStack, quoted),
      ...(tail !== '' ? [piece(quoted ? markGlobs(tail) : tail)] : []),
    ]
  }

  if (ntype === NT.EXPANSION) {
    const prefix = foldedWhitespace(tsNode)
    const expandChild = (c: TSNodeLike, inQuotes: boolean): Promise<Chunk[]> =>
      expandChunks(c, context, executeFn, callStack, view, inQuotes)
    const chunks = await expandBraces(tsNode, session, callStack, expandChild, view, quoted)
    return prefix !== '' ? [piece(prefix), ...chunks] : chunks
  }

  if (ntype === NT.COMMAND_SUBSTITUTION || ntype === NT.ARITHMETIC_EXPANSION) {
    const text = await substitution(tsNode, context, executeFn, callStack, view)
    const prefix = foldedWhitespace(tsNode)
    return [...(prefix !== '' ? [piece(prefix)] : []), valuePiece(text, quoted)]
  }

  if (ntype === NT.CONCATENATION) {
    // Each piece carries its own quoting, which is the whole reason
    // marks are per character: `'*'?.txt` joins a marked star to a live
    // question mark and still globs, on the `?` alone. A $"..." arrives
    // as an anonymous `$` token followed by the string node; the `$` is
    // the translation marker, not text. A bare trailing `$` (a$) has no
    // string after it and stays literal.
    const chunks: Chunk[] = []
    const children = tsNode.children
    for (let position = 0; position < children.length; position += 1) {
      const child = children[position]
      if (child === undefined) continue
      if (child.type === '$' && children[position + 1]?.type === NT.STRING) continue
      for (const c of await expandChunks(child, context, executeFn, callStack, view)) chunks.push(c)
    }
    return chunks
  }

  if (ntype === NT.STRING) return stringChunks(tsNode, context, executeFn, callStack, view)

  if (ntype === NT.TRANSLATED_STRING) {
    // $"..." asks for a locale translation; no message catalog is ever
    // loaded, so the translation is the identity and the word keeps
    // plain double-quote semantics.
    for (const child of tsNode.namedChildren) {
      if (child.type === NT.STRING) {
        return stringChunks(child, context, executeFn, callStack, view)
      }
    }
    return [piece('')]
  }

  const text = await literalNode(tsNode, context, executeFn, callStack, view)
  return [piece(quoted ? markGlobs(text) : text)]
}

/**
 * A double-quoted string's pieces, one field unless a splat splits it.
 *
 * Everything the quotes enclose is literal, the text and every value
 * alike: `"$p"?.txt` globs on the `?` alone. The quotes open a field
 * even around nothing (`""`), except that a `$@`-style splat over no
 * elements, with no other text, is no field at all: with no parameters
 * `"$@"` and `"$u$@"` are nothing, while one empty parameter is one
 * empty word. Only the element count decides that, never the rendered
 * text. A bad substitution names what the quotes enclose, or the whole
 * document of a heredoc the string stands for.
 */
async function stringChunks(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view: SessionView | undefined,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [piece('')]
  let splat = false
  let yielded = false
  const inside = node.parent?.heredoc?.body ?? node.text.slice(1, -1)
  for (const part of quotedParts(node)) {
    if (typeof part === 'string') {
      chunks.push(piece(markGlobs(part)))
      continue
    }
    const pieces = await named(
      inside,
      expandChunks(part, context, executeFn, callStack, view, true),
    )
    if (isAtSplat(part)) {
      splat = true
      yielded = yielded || pieces.length > 0
    }
    for (const c of pieces) chunks.push(c)
  }
  if (splat && !yielded && joinChunks(chunks) === '') return []
  return chunks
}

/** A command substitution's output or an arithmetic expansion's value. */
async function substitution(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view: SessionView | undefined,
): Promise<string> {
  const session = context.session
  const prefix = foldedWhitespace(tsNode)
  if (tsNode.type === NT.ARITHMETIC_EXPANSION) {
    const expr = await expandArith(tsNode, context, executeFn, callStack, view)
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
    return result.value.toString()
  }
  const rawSub = (tsNode.sourceText ?? tsNode.text).slice(prefix.length)
  if (rawSub.startsWith('`') && rawSub.endsWith('`')) {
    // Backtick regions are re-lexed here rather than trusted from the
    // grammar, which merges adjacent pairs (see splitBacktickRegion).
    return expandBacktickRegion(rawSub, context, executeFn, tsNode, prefix.length, callStack)
  }
  if (rawSub.startsWith('$((') && rawSub.endsWith('))')) {
    // Inside heredoc bodies tree-sitter parses `$((expr))` as a
    // command substitution wrapping a subshell; evaluate it as
    // arithmetic (python mirrors via a reparse; here the expression
    // text is reconstructed with `$`-refs substituted).
    const sub = tsNode.namedChildren
    const only = sub[0]
    if (sub.length === 1 && only?.type === NT.SUBSHELL) {
      const parenExpr = await substituteDollarRefs(only, context, executeFn, callStack, view)
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
      return arith.value.toString()
    }
  }
  // The whole body goes to the evaluator: bash substitutes the full
  // statement list, and picking child nodes dropped every statement
  // after a `;` and every non-command statement (declarations,
  // assignments, control flow).
  const inner = rawSub.slice(2, -1)
  if (inner.trim() === '') return ''
  // The substitution names its own node: the nested line's commands
  // stand under it, which is where the pass placed them.
  const io = await childLine(context, executeFn, inner, tsNode, callStack)
  const text = decodeText(await io.materializeStdout()).replace(/\n+$/, '')
  // Record the substitution's status: an assignment-only statement
  // whose value ran substitutions reports the last one's status as
  // its own (see assignmentStatus).
  context.frame.diagnostics.push(await io.materializeStderr())
  context.frame.cmdsubSeq += 1
  context.frame.cmdsubStatus = io.exitCode
  return text
}

/** The text of a node no expansion splits: quoted words and the rest. */
async function literalNode(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view: SessionView | undefined,
): Promise<string> {
  const ntype = tsNode.type

  if (ntype === NT.NUMBER) return tsNode.text

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

  if (ntype === NT.VARIABLE_ASSIGNMENT) {
    const raw = tsNode.text
    if (raw.includes('=')) {
      const eq = raw.indexOf('=')
      const key = raw.slice(0, eq)
      const valPart = raw.slice(eq + 1)
      const valNodes = tsNode.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
      if (valNodes.length > 0 && valNodes[0] !== undefined) {
        const expanded = await expandNode(valNodes[0], context, executeFn, callStack, view)
        return `${key}=${expanded}`
      }
      return `${key}=${valPart}`
    }
    return raw
  }

  return tsNode.text
}
