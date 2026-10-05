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

import { expandTilde } from '../utils/path.ts'
import { encodeText } from './bytes.ts'
import { FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN, FD_STDOUT } from './constants.ts'
import { decodeAnsiC, unescapeDquoted, unescapeUnquoted } from './escapes.ts'
import { bodyPrefix, cleanDelimiter, delimiterQuoted } from './parse/heredoc/index.ts'
import type { PipelineStages, TSNodeLike } from './types.ts'
import { NodeType as NT, ProcessSubDirection, Redirect, RedirectKind } from './types.ts'

export function getText(node: TSNodeLike): string {
  return node.text
}

/**
 * A node's children with the source text between them, the twin of
 * python's `source_parts`.
 *
 * tree-sitter-bash's scanner consumes some text without giving it a node:
 * whitespace and newlines inside a double-quoted string, and the whitespace
 * or line continuation opening a `${v:-word}` operand. Only the node's own
 * source still holds that text, so it is sliced out between child extents
 * rather than rebuilt from row or byte counts, which lose tabs, newlines and
 * escapes. web-tree-sitter counts `startIndex` in UTF-16 code units, the
 * units `text.slice` takes.
 */
export function* sourceParts(node: TSNodeLike): Generator<string | TSNodeLike> {
  const start = node.startIndex ?? 0
  let end = start
  for (const child of node.children) {
    const childStart = child.startIndex ?? end
    if (childStart > end) yield node.text.slice(end - start, childStart - start)
    end = child.endIndex ?? childStart + child.text.length
    yield child
  }
}

/**
 * Walk a double-quoted string without losing scanner-owned text.
 *
 * The text between children is the string's own, and the closing quote
 * token can carry the whitespace before it. Expansion nodes keep their own
 * folded prefixes.
 */
export function* quotedParts(node: TSNodeLike): Generator<string | TSNodeLike> {
  for (const part of sourceParts(node)) {
    if (typeof part === 'string') yield unescapeDquoted(part)
    else if (part.type === NT.DQUOTE) yield unescapeDquoted(part.text.slice(0, -1))
    else yield part
  }
}

/**
 * Where an index into a node's text falls in the parser's offsets, the twin
 * of python's `byte_offset`.
 *
 * tree-sitter places a node by the bytes of the UTF-8 source, so an index
 * counted in code units reads one place too early for every multibyte
 * character before it. `grep -ob` reads the same answer for the same reason.
 * `encodeText` rather than `TextEncoder` because a byte that is not valid
 * UTF-8 rides as a surrogate escape and stands for one byte. That is a
 * requirement on the caller, not a hope: grep's family decodes every line
 * through `decodeText` for it.
 */
export function byteOffset(text: string, index: number): number {
  return encodeText(text.slice(0, index)).length
}

export function getCommandName(node: TSNodeLike): string {
  for (const c of node.namedChildren) {
    if (c.type === NT.COMMAND_NAME) return c.text
  }
  return ''
}

export function getParts(node: TSNodeLike): TSNodeLike[] {
  // A bare `$` word is an anonymous token rather than a named child, but
  // bash passes it through as a literal argument (`echo $` prints `$`), so
  // it is the one anonymous child that stays - unless a string starts at
  // its very next byte, where it is the translation marker of `$"..."` and
  // the string node carries the whole word.
  const children = node.children
  const parts: TSNodeLike[] = []
  for (let position = 0; position < children.length; position += 1) {
    const c = children[position]
    if (c === undefined) continue
    if (c.isNamed === true && c.type !== NT.FILE_REDIRECT) {
      parts.push(c)
    } else if (c.type === '$') {
      const nxt = children[position + 1]
      if (nxt?.type !== NT.STRING || nxt.startIndex !== c.endIndex) {
        parts.push(c)
      }
    }
  }
  return parts
}

/**
 * Whether unquoted text holds a brace expansion (`{a,b}`, `{1..3}`),
 * which the shell turns into several words.
 */
export function braceExpands(text: string): boolean {
  let start = -1
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position]
    if (char === '{') {
      start = position
    } else if (char === '}' && start >= 0) {
      const body = text.slice(start + 1, position)
      if (body.includes(',') || body.includes('..')) return true
      start = -1
    }
  }
  return false
}

/**
 * The text a word names before any expansion, or null.
 *
 * A word is literal when nothing in it waits on the shell: a plain
 * word, a number, a quoted string with no expansion inside, or a
 * concatenation of those. Quotes are removed, escapes resolved and a
 * leading unquoted `~` expanded the way expansion would (`home` null
 * leaves it literal, as bash does with no `$HOME`). A word carrying a
 * parameter, command, arithmetic or process substitution, or a brace
 * expression, answers null: what it names is known only when it runs.
 */
export function literalWord(node: TSNodeLike, home: string | null = null): string | null {
  const ntype = node.type
  if (ntype === NT.COMMAND_NAME) {
    const first = node.namedChildren[0]
    return first === undefined ? node.text : literalWord(first, home)
  }
  if (
    (ntype === NT.WORD || ntype === NT.NUMBER || ntype === NT.CONCATENATION) &&
    braceExpands(node.text)
  ) {
    return null
  }
  if (ntype === NT.WORD || ntype === NT.NUMBER) {
    return expandTilde(unescapeUnquoted(node.text), home)
  }
  if (ntype === NT.RAW_STRING) return node.text.slice(1, -1)
  if (ntype === NT.ANSI_C_STRING) return decodeAnsiC(node.text.slice(2, -1))
  if (ntype === NT.TRANSLATED_STRING) {
    for (const child of node.namedChildren) {
      if (child.type === NT.STRING) return literalWord(child)
    }
    return ''
  }
  if (ntype === NT.STRING) {
    const pieces: string[] = []
    for (const child of quotedParts(node)) {
      if (typeof child === 'string') {
        pieces.push(child)
        continue
      }
      if (child.type !== NT.STRING_CONTENT) return null
      pieces.push(unescapeDquoted(child.text))
    }
    return pieces.join('')
  }
  if (ntype === NT.CONCATENATION) {
    const pieces: string[] = []
    const children = node.children
    for (let position = 0; position < children.length; position += 1) {
      const child = children[position]
      if (child === undefined) continue
      // The `$` of a `$"..."` is the translation marker, not text.
      if (child.type === '$' && children[position + 1]?.type === NT.STRING) continue
      // Only a leading unquoted piece carries a tilde prefix.
      const piece = literalWord(child, pieces.length === 0 ? home : null)
      if (piece === null) return null
      pieces.push(piece)
    }
    return pieces.join('')
  }
  if (ntype === '$') return '$'
  return null
}

/** Split FOO=1 BAR=2 cmd parts into [assignments, remaining]. */
export function splitEnvPrefix(parts: TSNodeLike[]): [TSNodeLike[], TSNodeLike[]] {
  const assignments: TSNodeLike[] = []
  const remaining: TSNodeLike[] = []
  let sawCommandName = false
  for (const p of parts) {
    if (!sawCommandName && p.type === NT.VARIABLE_ASSIGNMENT) {
      assignments.push(p)
      continue
    }
    if (p.type === NT.COMMAND_NAME) sawCommandName = true
    remaining.push(p)
  }
  return [assignments, remaining]
}

export function getPipelineCommands(node: TSNodeLike): [TSNodeLike[], boolean[]] {
  const commands: TSNodeLike[] = []
  const stderrFlags: boolean[] = []
  for (const c of node.children) {
    if (c.isNamed === true) {
      commands.push(c)
    } else if (c.type === NT.PIPE || c.type === NT.PIPE_STDERR) {
      stderrFlags.push(c.type === NT.PIPE_STDERR)
    }
  }
  return [commands, stderrFlags]
}

/**
 * A pipeline's stages as bash reads them, whatever shape the parse gave
 * them.
 *
 * tree-sitter-bash lets a redirect close over everything to its left up
 * to the next pipe, so `a && b | c < f | d` parses as a pipeline whose
 * first stage is `redirected(a && b | c, < f)`, and `! a < f | b` as one
 * whose first stage is `redirected(! a, < f)`. Bash reads them as
 * `a && (b | c <f | d)` and `! (a <f | b)`: the redirect binds to the
 * command it follows, the stages on both sides of it are one pipeline, a
 * `!` negates all of it, and a list the parse pulled into the first
 * stage runs ahead of the pipeline and decides whether it runs at all.
 * This is the last-command chain the admission gate climbs for a
 * redirect's target (`statementRedirects`), read in the direction the
 * executor walks. `redirects` are hoisted over the whole pipeline and
 * bind to its last stage.
 */
export function getPipelineStages(
  node: TSNodeLike,
  redirects: readonly Redirect[] = [],
): PipelineStages {
  const [commands, stderrFlags] = getPipelineCommands(node)
  const [first, ...rest] = commands
  if (first === undefined) throw new Error('pipeline: missing command')
  const head = pipelineHead(first)
  return bindLast(
    {
      commands: [...head.commands, ...rest],
      stderrFlags: [...head.stderrFlags, ...stderrFlags],
      redirects: [...head.redirects, ...rest.map(() => [])],
      negated: head.negated,
      lead: head.lead,
    },
    redirects,
  )
}

// `stages` with `redirects` bound to the last stage, after any it already
// carries (the inner ones come first in the source).
function bindLast(stages: PipelineStages, redirects: readonly Redirect[]): PipelineStages {
  if (redirects.length === 0) return stages
  const last = stages.redirects[stages.redirects.length - 1] ?? []
  return {
    ...stages,
    redirects: [...stages.redirects.slice(0, -1), [...last, ...redirects]],
  }
}

// The stages a pipeline's first element stands for. Only a redirected
// statement over a pipeline, a list or a negation is re-read; every other
// stage, a redirected command included, is one stage that runs as the
// node it is.
function pipelineHead(stage: TSNodeLike): PipelineStages {
  const single: PipelineStages = {
    commands: [stage],
    stderrFlags: [],
    redirects: [[]],
    negated: false,
    lead: null,
  }
  let body = stage
  let hoisted: readonly Redirect[] = []
  if (stage.type === NT.REDIRECTED_STATEMENT) {
    const [found, parsed] = getRedirects(stage)
    // A heredoc's `&&`/`||` tail wraps the whole statement, which only
    // the statement's own arm folds in.
    if (found === null || parsed.some((r) => r.continuation.length > 0)) return single
    body = found
    hoisted = parsed
  }
  if (body.type === NT.NEGATED_COMMAND) {
    return {
      commands: [getNegatedCommand(body)],
      stderrFlags: [],
      redirects: [hoisted],
      negated: true,
      lead: null,
    }
  }
  if (hoisted.length === 0) return single
  if (body.type === NT.PIPELINE) return getPipelineStages(body, hoisted)
  if (body.type === NT.LIST) {
    const [left, op, right] = getListParts(body)
    const inner =
      right.type === NT.PIPELINE
        ? getPipelineStages(right, hoisted)
        : bindLast(pipelineHead(right), hoisted)
    if (inner.lead === null) return { ...inner, lead: [left, op, right] }
  }
  return single
}

export function getWhileParts(node: TSNodeLike): [TSNodeLike, TSNodeLike[]] {
  const nc = node.namedChildren
  const condition = nc[0]
  if (condition === undefined) throw new Error('while/until: missing condition')
  const bodyNode = nc[1]
  const body = bodyNode !== undefined ? [...bodyNode.namedChildren] : []
  return [condition, body]
}

/**
 * Get (variable, values, bodyCommands) from for/select. The parser spells a
 * name the grammar cannot read as `for 0 in NAME`, so that header names NAME.
 */
export function getForParts(node: TSNodeLike): [string, TSNodeLike[], TSNodeLike[]] {
  const nc = node.namedChildren
  const first = nc[0]
  const last = nc[nc.length - 1]
  if (first === undefined || last === undefined) throw new Error('for: missing parts')
  const values = nc.slice(1).filter((c) => c.type !== NT.DO_GROUP && c.type !== NT.ERROR)
  const body = [...last.namedChildren]
  const spelled = values[0]
  if (getText(first) === '0' && spelled !== undefined && !/^\w+$/.test(getText(spelled))) {
    return [getText(spelled), values.slice(1), body]
  }
  return [getText(first), values, body]
}

/**
 * Get ([init, cond, update], bodyCommands) from a C-style for.
 *
 * The expression slots are positional between the (( )) delimiters,
 * separated by `;` tokens, and any of them may be empty (null):
 * `for ((;;))`.
 */
/**
 * ([init, cond, update], body) from a C-style for. The expression slots
 * are positional between the (( )) delimiters, separated by `;` tokens,
 * and any of them may be empty: `for ((;;))`. A slot holds every
 * comma-separated expression the parser found in it, in order, since
 * bash evaluates `for ((a=1, i=0; ...))` as one comma expression;
 * keeping only the last child dropped `a=1`.
 */
export function getCforParts(node: TSNodeLike): [TSNodeLike[][], TSNodeLike[]] {
  const exprs: TSNodeLike[][] = [[], [], []]
  let slot = 0
  let inside = false
  let body: TSNodeLike[] = []
  for (const child of node.children) {
    if (child.type === NT.ARITH_OPEN) {
      inside = true
      continue
    }
    if (child.type === NT.ARITH_CLOSE) {
      inside = false
      continue
    }
    if (inside) {
      if (child.type === NT.SEMI) slot += 1
      else if (child.isNamed === true && slot < 3) exprs[slot]?.push(child)
      continue
    }
    if (child.type === NT.DO_GROUP) body = [...child.namedChildren]
  }
  return [exprs, body]
}

/**
 * Whether a statement's terminator is `&`.
 *
 * tree-sitter puts the `&` beside the statement it ends, inside whatever
 * body holds them both, so a body read as named children (every
 * extractor above) never sees it. Asking the statement about its own
 * next sibling is what lets a loop body, an if/case arm, a brace group
 * and a function body launch the job the program loop launches for a
 * top-level `cmd &`.
 */
export function isBackgrounded(node: TSNodeLike): boolean {
  return node.nextSibling?.type === NT.BACKGROUND
}

export const REDIRECT_NODE_TYPES: ReadonlySet<string> = new Set([
  NT.FILE_REDIRECT,
  NT.HEREDOC_REDIRECT,
])

// RAW_STRING (single quotes) belongs here alongside STRING (double
// quotes): quoting a redirect target is purely syntactic in bash, so
// `> 'f'`, `> "f"` and `> f` name the same file. Omitting it left
// targetNode null and target '', which silently redirected every
// single-quoted target to one phantom empty path instead of the file.
const TARGET_TYPES: ReadonlySet<string> = new Set([
  NT.WORD,
  NT.CONCATENATION,
  NT.SIMPLE_EXPANSION,
  NT.EXPANSION,
  NT.COMMAND_SUBSTITUTION,
  NT.STRING,
  NT.RAW_STRING,
  NT.ANSI_C_STRING,
  NT.TRANSLATED_STRING,
  NT.PROCESS_SUBSTITUTION,
])

const INPUT_OPERATORS: ReadonlySet<string> = new Set([
  NT.REDIRECT_IN,
  NT.REDIRECT_DUP_IN,
  NT.REDIRECT_CLOSE_IN,
])
const CLOSE_OPERATORS: ReadonlySet<string> = new Set([NT.REDIRECT_CLOSE_OUT, NT.REDIRECT_CLOSE_IN])
const DUP_OPERATORS: ReadonlySet<string> = new Set([NT.REDIRECT_STDERR, NT.REDIRECT_DUP_IN])
const BOTH_OPERATORS: ReadonlySet<string> = new Set([NT.REDIRECT_BOTH, NT.REDIRECT_BOTH_APPEND])
const REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
  ...INPUT_OPERATORS,
  ...CLOSE_OPERATORS,
  ...DUP_OPERATORS,
  ...BOTH_OPERATORS,
  NT.REDIRECT_OUT,
  NT.REDIRECT_CLOBBER,
  NT.REDIRECT_APPEND,
])

/**
 * Parse a single file_redirect node into a Redirect.
 *
 * The operator token decides the shape and the explicit descriptor, when
 * there is one, is kept as typed: `3<f` claims fd 3 and `<&3` duplicates
 * from it, and both are refused downstream rather than read as stdin
 * (`shell/descriptors.ts`). Three forms carry a numeric target: a dup
 * (`2>&1`, `>&2`, `<&0`) names the descriptor it copies, a close (`>&-`,
 * `<&-`) carries FD_CLOSE, and `&>` claims FD_BOTH. `2>&1` alone keeps the
 * STDERR_TO_STDOUT kind the fd router keys on; every other output redirect
 * is STDOUT or STDERR by the descriptor it claims.
 */
function parseFileRedirect(child: TSNodeLike): Redirect {
  // The parser's redirect shield lets the grammar see `0<f` and `3<<< w`
  // with their descriptor (`operatorSource`); a redirect whose text opens
  // with `<<<` is a herestring.
  let fd: number | null = null
  let target: string | number = ''
  let targetNode: TSNodeLike | null = null
  let op: string | null = null
  let dupFd: number | null = null

  for (const c of child.children) {
    if (c.type === NT.FILE_DESCRIPTOR) {
      fd = parseInt(getText(c), 10)
    } else if (REDIRECT_OPERATORS.has(c.type)) {
      op = getText(c) === '<>' ? '<>' : c.type
    } else if (c.type === NT.NUMBER) {
      dupFd = parseInt(getText(c), 10)
    }
  }

  for (const c of child.namedChildren) {
    if (TARGET_TYPES.has(c.type)) {
      target = getText(c)
      targetNode = c
      break
    }
  }

  if (/^\d*<<</.test(getText(child))) return parseHerestringRedirect(child, fd ?? 0)
  if (child.heredoc !== undefined) {
    return new Redirect({
      fd: fd ?? 0,
      target: child.heredoc.body,
      targetNode,
      kind: RedirectKind.HEREDOC,
      expandVars: !child.heredoc.quoted,
    })
  }
  // `>&word` with a word rather than a number is bash's other spelling
  // of `&>word`, bare or on descriptor 1 (`1>&word` sends both streams
  // too, pinned on bash 5.2). On any other explicit descriptor bash
  // refuses it as `word: ambiguous redirect`, before the command runs and
  // before any file opens, so the parse keeps the word for the message
  // rather than turning `3>&foo` into a both-streams file.
  const wordDup = op === NT.REDIRECT_STDERR && dupFd === null && targetNode !== null
  if (wordDup && fd !== null && fd !== FD_STDOUT) {
    return new Redirect({ fd, target, targetNode, kind: RedirectKind.AMBIGUOUS })
  }
  if ((op !== null && BOTH_OPERATORS.has(op)) || wordDup) {
    return new Redirect({
      fd: FD_BOTH,
      target,
      targetNode,
      kind: RedirectKind.STDOUT,
      append: op === NT.REDIRECT_BOTH_APPEND,
    })
  }

  const input = op === '<>' || (op !== null && INPUT_OPERATORS.has(op))
  fd ??= input ? FD_STDIN : FD_STDOUT
  if (op !== null && CLOSE_OPERATORS.has(op)) target = FD_CLOSE
  else if (op !== null && DUP_OPERATORS.has(op) && dupFd !== null) target = dupFd

  let kind: RedirectKind
  if (op === '<>') kind = RedirectKind.READWRITE
  else if (input) kind = RedirectKind.STDIN
  else if (fd === FD_STDERR && target === FD_STDOUT && op === NT.REDIRECT_STDERR) {
    kind = RedirectKind.STDERR_TO_STDOUT
  } else if (fd === FD_STDERR) kind = RedirectKind.STDERR
  else kind = RedirectKind.STDOUT

  return new Redirect({
    fd,
    target,
    targetNode,
    kind,
    append: op === NT.REDIRECT_APPEND,
    clobber: op === NT.REDIRECT_CLOBBER,
  })
}

function parseHerestringRedirect(child: TSNodeLike, fd: number): Redirect {
  const word = child.namedChildren.find((candidate) => candidate.type !== NT.FILE_DESCRIPTOR)
  return new Redirect({
    fd,
    target: word === undefined ? '' : getText(word),
    targetNode: word ?? null,
    kind: RedirectKind.HERESTRING,
  })
}

/**
 * Parse all redirects from a redirected_statement.
 *
 * Returns [command, redirects]; command is null for a bare redirect
 * like `> file` (bash runs the empty command and applies redirects,
 * creating/truncating the file).
 */
export function getRedirects(node: TSNodeLike): [TSNodeLike | null, Redirect[]] {
  const nc = node.namedChildren
  const first = nc[0]
  const command = first !== undefined && !REDIRECT_NODE_TYPES.has(first.type) ? first : null
  const redirects: Redirect[] = []

  for (let i = command === null ? 0 : 1; i < nc.length; i++) {
    const child = nc[i]
    if (child?.type === NT.HEREDOC_REDIRECT) {
      const [body, , quoted] = getHeredocMeta(child)
      const [pipeNode, continuation] = heredocTail(child)
      const descriptor = child.namedChildren.find((c) => c.type === NT.FILE_DESCRIPTOR)
      redirects.push(
        new Redirect({
          fd: descriptor === undefined ? 0 : parseInt(getText(descriptor), 10),
          target: body,
          targetNode: child,
          kind: RedirectKind.HEREDOC,
          pipeline: pipeNode,
          expandVars: !quoted,
          continuation,
        }),
      )
      // A file redirect written before the heredoc body starts
      // (`cat <<END > out.txt`) parses INSIDE the heredoc_redirect
      // node; hoist it to a sibling.
      for (const hc of child.namedChildren) {
        if (hc.type === NT.FILE_REDIRECT) {
          redirects.push(parseFileRedirect(hc))
        }
      }
    } else if (child?.type === NT.FILE_REDIRECT) {
      redirects.push(parseFileRedirect(child))
    }
  }

  return [
    command?.type === NT.COMMAND && getParts(command).length === 0 ? null : command,
    redirects,
  ]
}

/**
 * The leftmost operand of a `&&`/`||` list and the steps after it.
 *
 * tree-sitter nests a list to the left (`a || b && c` is
 * `list(list(a || b) && c)`), which is bash's own associativity, so
 * walking the left spine yields the first operand and then each operator
 * with its right operand in the order bash applies them.
 */
export function listSpine(node: TSNodeLike): [TSNodeLike, [string, TSNodeLike][]] {
  const steps: [string, TSNodeLike][] = []
  let current = node
  while (current.type === NT.LIST) {
    const [left, op, right] = getListParts(current)
    steps.push([op ?? '&&', right])
    current = left
  }
  steps.reverse()
  return [current, steps]
}

/**
 * What the operator line carries past a heredoc's delimiter word.
 *
 * Bash reads the body at the newline and then goes on with the line, so
 * `cat <<EOF | tr a-z A-Z && echo done` is the pipeline `cat | tr` and
 * then `&& echo done`. tree-sitter-bash parses that tail inside the
 * heredoc_redirect node instead: a `pipeline` child holding the stage the
 * command feeds, and an `&&` or `||` token followed by its right operand.
 * The stage or operand it hands over can itself be a `list`, wrapping
 * what bash would have bound to the left (`false <<EOF || echo a && echo
 * b` is `(false || echo a) && echo b`, not `false || (echo a && echo b)`),
 * so a list is unwound along its left spine: its first operand takes the
 * stage or operand slot, and the rest become further steps.
 *
 * Returns the node the command's stdout pipes into, or null, and the
 * `[operator, right]` steps applied to the statement after that, in order.
 */
export function heredocTail(redirectNode: TSNodeLike): [TSNodeLike | null, [string, TSNodeLike][]] {
  let pipeNode: TSNodeLike | null = null
  const steps: [string, TSNodeLike][] = []
  const children = redirectNode.children
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child === undefined) continue
    if (child.type === NT.PIPELINE && pipeNode === null && steps.length === 0) {
      const stages = child.namedChildren
      const only = stages[0]
      if (stages.length === 1 && only?.type === NT.LIST) {
        const [leaf, spine] = listSpine(only)
        pipeNode = leaf
        steps.push(...spine)
      } else {
        pipeNode = child
      }
      continue
    }
    const next = children[index + 1]
    if ((child.type === NT.AND || child.type === NT.OR) && next?.isNamed === true) {
      const [right, spine] = listSpine(next)
      steps.push([child.type, right], ...spine)
      index += 1
    }
  }
  return [pipeNode, steps]
}

/**
 * Detach the `&&`/`||` steps a heredoc's operator line carried.
 *
 * The steps apply to the whole redirected statement, so the executor
 * takes them off the redirects before running it and folds them in
 * around the result, the way a `list` node wraps its left operand.
 */
export function takeContinuation(redirects: readonly Redirect[]): [string, TSNodeLike][] {
  const steps: [string, TSNodeLike][] = []
  for (const r of redirects) {
    if (r.continuation.length > 0) {
      steps.push(
        ...(r.continuation as readonly (readonly [string, TSNodeLike])[]).map(
          ([op, right]) => [op, right] as [string, TSNodeLike],
        ),
      )
      r.continuation = []
    }
  }
  return steps
}

export function getListParts(node: TSNodeLike): [TSNodeLike, string | null, TSNodeLike] {
  const left = node.namedChildren[0]
  const right = node.namedChildren[1]
  if (left === undefined || right === undefined) throw new Error('list: missing parts')
  let op: string | null = null
  for (const c of node.children) {
    if (c.type === NT.AND || c.type === NT.OR || c.type === NT.SEMI) {
      op = c.type
      break
    }
  }
  return [left, op, right]
}

export function getIfBranches(
  node: TSNodeLike,
): [[TSNodeLike, TSNodeLike[]][], TSNodeLike[] | null] {
  const nc = node.namedChildren
  let condition: TSNodeLike | null = nc[0] ?? null
  let body: TSNodeLike[] = []
  const branches: [TSNodeLike, TSNodeLike[]][] = []
  let elseBody: TSNodeLike[] | null = null

  for (let i = 1; i < nc.length; i++) {
    const c = nc[i]
    if (c === undefined) continue
    if (c.type === NT.ELIF_CLAUSE) {
      if (condition !== null) branches.push([condition, body])
      const ec = c.namedChildren
      condition = ec[0] ?? null
      body = ec.slice(1)
    } else if (c.type === NT.ELSE_CLAUSE) {
      if (condition !== null) {
        branches.push([condition, body])
        condition = null
      }
      elseBody = [...c.namedChildren]
    } else {
      body.push(c)
    }
  }

  if (condition !== null) branches.push([condition, body])
  return [branches, elseBody]
}

export function getCaseWord(node: TSNodeLike): TSNodeLike {
  const first = node.namedChildren[0]
  if (first === undefined) throw new Error('case: missing word')
  return first
}

/**
 * Get (patternNodes, bodyStatements, terminator) triples from case.
 *
 * Patterns are every named child before the arm's `)`, kept as nodes so
 * quoting survives to the matcher: 'a'), "$x") and $'a\n') all mean literal
 * text where a bare word keeps its globs live. An arm's body is every
 * statement up to its terminator, so multi-statement arms
 * (x) cmd1; cmd2;;) keep all commands.
 */
export function getCaseItems(node: TSNodeLike): [TSNodeLike[], TSNodeLike[], string][] {
  const items: [TSNodeLike[], TSNodeLike[], string][] = []
  for (const c of node.namedChildren) {
    if (c.type !== NT.CASE_ITEM) continue
    const patterns: TSNodeLike[] = []
    const body: TSNodeLike[] = []
    let terminator = ';;'
    let inBody = false
    for (const child of c.children) {
      if (child.type === ';;' || child.type === ';&' || child.type === ';;&') {
        terminator = child.type
      } else if (child.type === ')') {
        inBody = true
      } else if (child.isNamed !== true) {
        continue
      } else if (inBody) {
        body.push(child)
      } else {
        patterns.push(child)
      }
    }
    items.push([patterns, body, terminator])
  }
  return items
}

export function getDeclarationKeyword(node: TSNodeLike): string {
  return node.children[0]?.type ?? ''
}

/**
 * Split a whitespace-separated operand string, honoring single and
 * double quotes the way the shell does. Returns null on an unbalanced
 * quote so the caller can fall back. Mirrors Python's `shlex.split` for
 * the un-expanded operand cases `unset` needs.
 */
function shellSplit(text: string): string[] | null {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inSingle) {
      if (ch === "'") inSingle = false
      else cur += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === '\\' && (text.charAt(i + 1) === '"' || text.charAt(i + 1) === '\\'))
        cur += text.charAt(++i)
      else cur += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      has = true
    } else if (ch === '"') {
      inDouble = true
      has = true
    } else if (ch === '\\' && i + 1 < text.length) {
      cur += text.charAt(++i)
      has = true
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has) {
        tokens.push(cur)
        cur = ''
        has = false
      }
    } else {
      cur += ch
      has = true
    }
  }
  if (inSingle || inDouble) return null
  if (has) tokens.push(cur)
  return tokens
}

/**
 * Get every operand word of an unset_command, keeping `-f`/`-v`/`-n` and
 * keeping a subscript target (`unset arr[1]`, quoted or not) as one word.
 * Mirrors Python's `get_unset_args`.
 */
export function getUnsetArgs(node: TSNodeLike): string[] {
  const operands = node.children.slice(1)
  const first = operands[0]
  if (first === undefined) return []
  if (first.startIndex !== undefined && node.startIndex !== undefined) {
    const split = shellSplit(node.text.slice(first.startIndex - node.startIndex))
    if (split !== null) return split
  }
  return node.namedChildren.map((c) => getText(c))
}

export function getNegatedCommand(node: TSNodeLike): TSNodeLike {
  const first = node.namedChildren[0]
  if (first === undefined) throw new Error('negated_command: missing inner')
  return first
}

// The body opens with the empty lines tree-sitter dropped before its
// heredoc_body node (see bodyPrefix); bash keeps them.
function getHeredocParts(redirectNode: TSNodeLike): [string, string] {
  let delimiter = ''
  let body = ''
  for (const c of redirectNode.namedChildren) {
    if (c.type === NT.HEREDOC_START) delimiter = getText(c)
    else if (c.type === NT.HEREDOC_BODY) body = getText(c)
  }
  return [delimiter, bodyPrefix(redirectNode) + body]
}

function getHeredocMeta(redirectNode: TSNodeLike): [string, boolean, boolean] {
  const [delimiter, rawBody] = getHeredocParts(redirectNode)
  const quoted = delimiterQuoted(delimiter)
  let dash = false
  for (const c of redirectNode.children) {
    if (c.type === '<<-') {
      dash = true
      break
    }
  }
  let body = rawBody
  if (dash && body !== '') {
    body = body
      .split('\n')
      .map((line) => line.replace(/^\t+/, ''))
      .join('\n')
  }
  return [normalizeHeredocBody(body, delimiter), dash, quoted]
}

/**
 * Repair tree-sitter quirks on concatenated delimiters (<<EN'D').
 *
 * tree-sitter sometimes fails to match the closing line against a
 * concatenated delimiter: the body swallows the delimiter line, or
 * loses its final newline to heredoc_end. Bash strips quoting from
 * the delimiter before matching and bodies always end with a newline.
 */
export function normalizeHeredocBody(body: string, delimiter: string): string {
  const clean = cleanDelimiter(delimiter)
  const suffix = clean + '\n'
  let out = body
  if (out.endsWith(suffix)) {
    const head = out.slice(0, -suffix.length)
    if (head === '' || head.endsWith('\n')) out = head
  }
  if (out !== '' && !out.endsWith('\n')) out += '\n'
  return out
}

export function getProcessSubDirection(node: TSNodeLike): ProcessSubDirection | null {
  const open = node.children[0]?.type ?? ''
  if (open === '<(') return ProcessSubDirection.INPUT
  if (open === '>(') return ProcessSubDirection.OUTPUT
  return null
}

/**
 * Bash's single-file command substitution, measured against 5.2.37.
 * Only a lone foreground `< file` (optionally `0<`) reads input into
 * the substitution. Extra redirects, commands, heredocs and descriptor
 * duplication retain ordinary redirect-only semantics.
 */
export function inputSubstitutionRedirect(node: TSNodeLike): Redirect | null {
  if (node.children.some((child) => child.type === '&')) return null
  const statements = node.namedChildren.filter((child) => child.type !== NT.COMMENT)
  const statement = statements[0]
  if (statements.length !== 1 || statement === undefined) return null
  if (statement.type !== NT.REDIRECTED_STATEMENT && statement.type !== NT.FILE_REDIRECT) return null
  const [command, redirects] =
    statement.type === NT.FILE_REDIRECT
      ? [null, [parseFileRedirect(statement)]]
      : getRedirects(statement)
  const redirect = redirects[0]
  if (
    command !== null ||
    redirects.length !== 1 ||
    redirect?.kind !== RedirectKind.STDIN ||
    redirect.fd !== 0 ||
    typeof redirect.target === 'number'
  )
    return null
  return redirect
}

export function getProcessSubBody(node: TSNodeLike): string {
  const text = node.sourceText ?? node.text
  if ((text.startsWith('<(') || text.startsWith('>(')) && text.endsWith(')')) {
    return text.slice(2, -1)
  }
  return text
}

export function getFunctionName(node: TSNodeLike): string {
  const first = node.namedChildren[0]
  return first !== undefined ? getText(first) : ''
}

/**
 * Get function body commands: the compound_statement's children, or any
 * other compound command (`f() ( ... )`) as the one statement. The redirects
 * a definition carries, its own and those of a statement it is the body of
 * (`f() { ...; } >o 2>&1`), apply at every call, as bash's do, so then the
 * body is one statement: the group under them. Mirrors Python's
 * get_function_body.
 */
/**
 * The redirects a function definition carries: its own, and those of a
 * statement it is the body of (`f() { ...; } >o 2>&1`, whose second
 * redirect tree-sitter hangs on a redirected_statement around it).
 */
export function getFunctionRedirects(node: TSNodeLike): TSNodeLike[] {
  const redirects = node.namedChildren.filter((c) => REDIRECT_NODE_TYPES.has(c.type))
  const outer = node.parent
  if (
    outer?.type === NT.REDIRECTED_STATEMENT &&
    outer.namedChildren[0]?.id !== undefined &&
    outer.namedChildren[0].id === node.id
  ) {
    redirects.push(...outer.namedChildren.slice(1).filter((c) => REDIRECT_NODE_TYPES.has(c.type)))
  }
  return redirects
}

export function getFunctionBody(node: TSNodeLike): TSNodeLike[] | null {
  const body =
    node.childForFieldName?.('body') ??
    node.namedChildren.find((c) => c.type === NT.COMPOUND_STATEMENT)
  if (body === undefined) return null
  const redirects = getFunctionRedirects(node)
  if (redirects.length === 0) {
    return body.type === NT.COMPOUND_STATEMENT ? [...body.namedChildren] : [body]
  }
  const parts = [body, ...redirects]
  return [
    {
      type: NT.REDIRECTED_STATEMENT,
      text: node.text,
      children: parts,
      namedChildren: parts,
      parent: null,
      nextSibling: null,
      ...(node.id === undefined ? {} : { id: node.id }),
      ...(node.startIndex === undefined ? {} : { startIndex: node.startIndex }),
      ...(node.endIndex === undefined ? {} : { endIndex: node.endIndex }),
      ...(node.startPosition === undefined ? {} : { startPosition: node.startPosition }),
      ...(node.endPosition === undefined ? {} : { endPosition: node.endPosition }),
    },
  ]
}
