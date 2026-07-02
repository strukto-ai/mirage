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

import type { TSNodeLike } from '../workspace/expand/variable.ts'
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
  return node.namedChildren.filter((c) => !SKIP_PARTS.has(c.type))
}

/**
 * Split FOO=1 BAR=2 cmd parts into [assignments, remaining].
 *
 * The single structural rule for env-prefixed commands, shared by the
 * executor (which expands and applies the assignments) and the
 * provision planner (which only needs the command parts).
 */
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

export function getSubshellBody(node: TSNodeLike): TSNodeLike[] {
  return [...node.namedChildren]
}

const TARGET_TYPES: ReadonlySet<string> = new Set([
  NT.WORD,
  NT.CONCATENATION,
  NT.SIMPLE_EXPANSION,
  NT.EXPANSION,
  NT.COMMAND_SUBSTITUTION,
  NT.STRING,
])

export function getRedirects(node: TSNodeLike): [TSNodeLike, Redirect[]] {
  const nc = node.namedChildren
  const command = nc[0]
  if (command === undefined) throw new Error('redirect: missing command')
  const redirects: Redirect[] = []

  for (let i = 1; i < nc.length; i++) {
    const child = nc[i]
    if (child === undefined) continue

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
          kind: RedirectKind.HEREDOC,
          pipeline: pipeNode,
          expandVars: !quoted,
        }),
      )
      continue
    }

    if (child.type === NT.HERESTRING_REDIRECT) {
      let content = ''
      for (const sc of child.children) {
        if (sc.isNamed === true && sc.type !== NT.HERESTRING_TOKEN) {
          content = getText(sc)
          break
        }
      }
      redirects.push(new Redirect({ fd: 0, target: content, kind: RedirectKind.HERESTRING }))
      continue
    }

    if (child.type !== NT.FILE_REDIRECT) continue

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
      kind = RedirectKind.STDOUT
      redirects.push(new Redirect({ fd: -1, target, targetNode, kind, append }))
      continue
    }

    if (fd === 2 && kind !== RedirectKind.STDERR_TO_STDOUT) {
      kind = RedirectKind.STDERR
    }

    redirects.push(new Redirect({ fd, target, targetNode, kind, append }))
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

export function getCaseItems(node: TSNodeLike): [string[], TSNodeLike | null][] {
  const items: [string[], TSNodeLike | null][] = []
  for (const c of node.namedChildren) {
    if (c.type !== NT.CASE_ITEM) continue
    const patterns: string[] = []
    let body: TSNodeLike | null = null
    for (const child of c.children) {
      if (
        child.type === NT.EXTGLOB_PATTERN ||
        child.type === NT.WORD ||
        child.type === NT.CONCATENATION ||
        child.type === NT.STRING
      ) {
        patterns.push(getText(child))
      } else if (child.isNamed === true && child.type !== '|') {
        body = child
        break
      }
    }
    if (patterns.length === 0) {
      const first = c.namedChildren[0]
      if (first !== undefined) patterns.push(getText(first))
    }
    items.push([patterns, body])
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
  const quoted =
    (delimiter.startsWith("'") && delimiter.endsWith("'")) ||
    (delimiter.startsWith('"') && delimiter.endsWith('"'))
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
  return [body, dash, quoted]
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
