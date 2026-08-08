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

import type { TSNodeLike } from './types.ts'
import { NodeType as NT, Redirect, RedirectKind } from './types.ts'

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
export function getCforParts(node: TSNodeLike): [(TSNodeLike | null)[], TSNodeLike[]] {
  const exprs: (TSNodeLike | null)[] = [null, null, null]
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
      else if (child.isNamed === true && slot < 3) exprs[slot] = child
      continue
    }
    if (child.type === NT.DO_GROUP) body = [...child.namedChildren]
  }
  return [exprs, body]
}

export function getSubshellBody(node: TSNodeLike): TSNodeLike[] {
  return [...node.namedChildren]
}

const REDIRECT_NODE_TYPES: ReadonlySet<string> = new Set([
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

function parseFileRedirect(child: TSNodeLike): Redirect {
  let fd = 1
  let target: string | number = ''
  let targetNode: TSNodeLike | null = null
  let kind: RedirectKind = RedirectKind.STDOUT
  let append = false
  let dupFd: number | null = null

  for (const c of child.children) {
    if (c.type === NT.FILE_DESCRIPTOR) {
      fd = parseInt(getText(c), 10)
    } else if (c.type === NT.REDIRECT_OUT) {
      // default STDOUT
    } else if (c.type === NT.REDIRECT_APPEND) {
      append = true
    } else if (c.type === NT.REDIRECT_IN) {
      kind = RedirectKind.STDIN
      fd = 0
    } else if (c.type === NT.REDIRECT_STDERR) {
      kind = RedirectKind.STDERR_TO_STDOUT
    } else if (c.type === NT.REDIRECT_BOTH) {
      kind = RedirectKind.STDOUT
      fd = -1
    } else if (c.type === NT.REDIRECT_BOTH_APPEND) {
      kind = RedirectKind.STDOUT
      fd = -1
      append = true
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

  if (dupFd !== null && kind === RedirectKind.STDERR_TO_STDOUT) {
    if (fd === 2 && dupFd === 1) {
      kind = RedirectKind.STDERR_TO_STDOUT
      target = dupFd
    } else if (fd === 1 && dupFd === 2) {
      kind = RedirectKind.STDOUT
      fd = 1
      target = 2
    } else {
      target = dupFd
    }
  }

  if (fd === -1) {
    return new Redirect({ fd: -1, target, targetNode, kind: RedirectKind.STDOUT, append })
  }

  if (fd === 2 && kind !== RedirectKind.STDERR_TO_STDOUT) {
    kind = RedirectKind.STDERR
  }

  return new Redirect({ fd, target, targetNode, kind, append })
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

  if (command !== null && command.type === NT.COMMAND) {
    for (const child of command.namedChildren) {
      if (child.type === NT.HERESTRING_REDIRECT) {
        redirects.push(parseHerestringRedirect(child))
      }
    }
  }

  let recoverHerestring = false
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

    redirects.push(recoverHerestring ? parseHerestringRedirect(child) : parseFileRedirect(child))
    recoverHerestring = false
  }

  return [command, redirects]
}

export function getRedirectTargetNode(node: TSNodeLike): TSNodeLike | null {
  const [, redirects] = getRedirects(node)
  const first = redirects[0]
  if (first === undefined) return null
  return (first.targetNode as TSNodeLike | null) ?? null
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

export function getUnsetNames(node: TSNodeLike): string[] {
  return node.namedChildren.filter((c) => c.type === NT.VARIABLE_NAME).map((c) => getText(c))
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

export function getHeredocParts(redirectNode: TSNodeLike): [string, string] {
  let delimiter = ''
  let body = ''
  for (const c of redirectNode.namedChildren) {
    if (c.type === NT.HEREDOC_START) delimiter = getText(c)
    else if (c.type === NT.HEREDOC_BODY) body = getText(c)
  }
  return [delimiter, body]
}

export function getHeredocMeta(redirectNode: TSNodeLike): [string, boolean, boolean] {
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

export function getHerestringContent(node: TSNodeLike): string {
  for (const c of node.namedChildren) {
    if (c.type === NT.HERESTRING_REDIRECT) {
      const first = c.namedChildren[0]
      return first !== undefined ? getText(first) : ''
    }
  }
  return ''
}

export function getProcessSubCommand(node: TSNodeLike): TSNodeLike {
  const first = node.namedChildren[0]
  if (first === undefined) throw new Error('process_substitution: missing inner')
  return first
}

export const ProcessSubDirection = {
  INPUT: 'input',
  OUTPUT: 'output',
} as const
export type ProcessSubDirection = (typeof ProcessSubDirection)[keyof typeof ProcessSubDirection]

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
