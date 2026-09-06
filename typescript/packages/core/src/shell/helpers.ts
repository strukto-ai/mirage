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
import { FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN, FD_STDOUT } from './constants.ts'
import { decodeAnsiC, unescapeDquoted, unescapeUnquoted } from './escapes.ts'
import type { TSNodeLike } from './types.ts'
import { NodeType as NT, ProcessSubDirection, Redirect, RedirectKind } from './types.ts'

export function getText(node: TSNodeLike): string {
  return node.text
}

export function getCommandName(node: TSNodeLike): string {
  for (const c of node.namedChildren) {
    if (c.type === NT.COMMAND_NAME) return c.text
  }
  return ''
}

const SKIP_PARTS: ReadonlySet<string> = new Set([NT.FILE_REDIRECT, NT.HERESTRING_REDIRECT])

/**
 * The descriptor a bare `0` before a redirect operator names.
 *
 * tree-sitter-bash reads `0>&-` and `0<f` as an operand `0` followed by an
 * undecorated redirect, where it gives every other digit string its
 * `file_descriptor` node. bash's rule is that a digit string touching the
 * operator is the descriptor, so the number is one when it ends exactly
 * where a sibling `file_redirect` begins; `cat a 0 >&-` keeps its operand.
 */
export function claimedDescriptor(command: TSNodeLike, last: TSNodeLike): number | null {
  if (last.type !== NT.NUMBER || command.parent == null) return null
  for (const sibling of command.parent.namedChildren) {
    if (sibling.type === NT.FILE_REDIRECT && sibling.startIndex === last.endIndex) {
      return parseInt(getText(last), 10)
    }
  }
  return null
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
    if (c.isNamed === true && !SKIP_PARTS.has(c.type)) {
      if (position === children.length - 1 && claimedDescriptor(node, c) !== null) continue
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
    for (const child of node.children) {
      if (child.type === NT.DQUOTE) continue
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

/**
 * Split FOO=1 BAR=2 cmd parts into [assignments, remaining].
 *
 * The single structural rule for env-prefixed commands, shared by the
 * executor (which expands and applies the assignments) and the
 * provision planner (which only needs the command parts).
 */
export function hasCommandSubstitution(node: TSNodeLike): boolean {
  // The provision planner suppresses substitution execution, so any
  // word carrying one expands to empty during a plan walk and the
  // affected estimate must degrade to UNKNOWN instead of trusting the
  // incomplete expansion.
  if (node.type === NT.COMMAND_SUBSTITUTION || node.type === NT.PROCESS_SUBSTITUTION) return true
  return node.namedChildren.some((c) => hasCommandSubstitution(c))
}

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

export function getWhileParts(node: TSNodeLike): [TSNodeLike, TSNodeLike[]] {
  const nc = node.namedChildren
  const condition = nc[0]
  if (condition === undefined) throw new Error('while/until: missing condition')
  const bodyNode = nc[1]
  const body = bodyNode !== undefined ? [...bodyNode.namedChildren] : []
  return [condition, body]
}

export function getForParts(node: TSNodeLike): [string, TSNodeLike[], TSNodeLike[]] {
  const nc = node.namedChildren
  const first = nc[0]
  const last = nc[nc.length - 1]
  if (first === undefined || last === undefined) throw new Error('for: missing parts')
  const variable = getText(first)
  const values = nc.slice(1).filter((c) => c.type !== NT.DO_GROUP && c.type !== NT.ERROR)
  const body = [...last.namedChildren]
  return [variable, values, body]
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

export function getSubshellBody(node: TSNodeLike): TSNodeLike[] {
  return [...node.namedChildren]
}

export const REDIRECT_NODE_TYPES: ReadonlySet<string> = new Set([
  NT.FILE_REDIRECT,
  NT.HEREDOC_REDIRECT,
  NT.HERESTRING_REDIRECT,
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
function parseFileRedirect(child: TSNodeLike, claimed: number | null = null): Redirect {
  // `claimed` is the descriptor the grammar left as the command's last
  // operand (`claimedDescriptor`), which a `file_descriptor` child
  // overrides.
  let fd: number | null = claimed
  let target: string | number = ''
  let targetNode: TSNodeLike | null = null
  let op: string | null = null
  let dupFd: number | null = null

  for (const c of child.children) {
    if (c.type === NT.FILE_DESCRIPTOR) {
      fd = parseInt(getText(c), 10)
    } else if (REDIRECT_OPERATORS.has(c.type)) {
      op = c.type
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

  const input = op !== null && INPUT_OPERATORS.has(op)
  fd ??= input ? FD_STDIN : FD_STDOUT
  if (op !== null && CLOSE_OPERATORS.has(op)) target = FD_CLOSE
  else if (op !== null && DUP_OPERATORS.has(op) && dupFd !== null) target = dupFd

  let kind: RedirectKind
  if (input) kind = RedirectKind.STDIN
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

function parseHerestringRedirect(child: TSNodeLike): Redirect {
  let content = ''
  let targetNode: TSNodeLike | null = null
  for (const candidate of child.namedChildren) {
    if (TARGET_TYPES.has(candidate.type)) {
      content = getText(candidate)
      targetNode = candidate
      break
    }
  }
  return new Redirect({ fd: 0, target: content, targetNode, kind: RedirectKind.HERESTRING })
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

  let claimed: number | null = null
  if (command !== null && command.type === NT.COMMAND) {
    for (const child of command.namedChildren) {
      if (child.type === NT.HERESTRING_REDIRECT) {
        redirects.push(parseHerestringRedirect(child))
      }
    }
    const last = command.children[command.children.length - 1]
    if (last !== undefined) claimed = claimedDescriptor(command, last)
  }

  let recoverHerestring = false
  const commandEnd = command === null ? -1 : command.endIndex
  for (let i = command === null ? 0 : 1; i < nc.length; i++) {
    const child = nc[i]
    if (child === undefined) continue

    if (child.type === NT.ERROR && getText(child) === '<<') {
      recoverHerestring = true
      continue
    }

    if (child.type === NT.HEREDOC_REDIRECT) {
      const [body, , quoted] = getHeredocMeta(child)
      let pipeNode: TSNodeLike | null = null
      for (const hc of child.namedChildren) {
        if (hc.type === NT.PIPELINE || hc.type === NT.COMMAND) {
          pipeNode = hc
          break
        }
      }
      redirects.push(
        new Redirect({
          fd: 0,
          target: body,
          targetNode: child,
          kind: RedirectKind.HEREDOC,
          pipeline: pipeNode,
          expandVars: !quoted,
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
      continue
    }

    if (child.type === NT.HERESTRING_REDIRECT) {
      redirects.push(parseHerestringRedirect(child))
      recoverHerestring = false
      continue
    }

    if (child.type !== NT.FILE_REDIRECT) {
      recoverHerestring = false
      continue
    }

    if (recoverHerestring) {
      redirects.push(parseHerestringRedirect(child))
    } else {
      // Only the redirect touching the operand can own it.
      redirects.push(parseFileRedirect(child, child.startIndex === commandEnd ? claimed : null))
    }
    recoverHerestring = false
  }

  return [command, redirects]
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

export function getDeclarationAssignments(node: TSNodeLike): string[] {
  return node.namedChildren.filter((c) => c.type === NT.VARIABLE_ASSIGNMENT).map((c) => getText(c))
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

export function getTestArgv(node: TSNodeLike): string[] {
  return node.namedChildren.map((c) => getText(c))
}

export function getCommandAssignments(node: TSNodeLike): string[] {
  return node.namedChildren.filter((c) => c.type === NT.VARIABLE_ASSIGNMENT).map((c) => getText(c))
}

export function getNegatedCommand(node: TSNodeLike): TSNodeLike {
  const first = node.namedChildren[0]
  if (first === undefined) throw new Error('negated_command: missing inner')
  return first
}

function getHeredocParts(redirectNode: TSNodeLike): [string, string] {
  let delimiter = ''
  let body = ''
  for (const c of redirectNode.namedChildren) {
    if (c.type === NT.HEREDOC_START) delimiter = getText(c)
    else if (c.type === NT.HEREDOC_BODY) body = getText(c)
  }
  return [delimiter, body]
}

function getHeredocMeta(redirectNode: TSNodeLike): [string, boolean, boolean] {
  const [delimiter, rawBody] = getHeredocParts(redirectNode)
  // Any quoting anywhere in the delimiter (even partial, `EN'D'`)
  // disables expansion, matching bash.
  const quoted = delimiter.includes("'") || delimiter.includes('"') || delimiter.includes('\\')
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
function normalizeHeredocBody(body: string, delimiter: string): string {
  const clean = delimiter.replaceAll("'", '').replaceAll('"', '')
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

export function getProcessSubBody(node: TSNodeLike): string {
  const text = getText(node)
  if ((text.startsWith('<(') || text.startsWith('>(')) && text.endsWith(')')) {
    return text.slice(2, -1)
  }
  return text
}

export function getFunctionName(node: TSNodeLike): string {
  const first = node.namedChildren[0]
  return first !== undefined ? getText(first) : ''
}

export function getFunctionBody(node: TSNodeLike): TSNodeLike[] | null {
  for (const c of node.namedChildren) {
    if (c.type === NT.COMPOUND_STATEMENT) return [...c.namedChildren]
  }
  return null
}
