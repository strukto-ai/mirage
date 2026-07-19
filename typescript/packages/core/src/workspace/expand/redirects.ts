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

import { materialize } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import {
  getProcessSubBody,
  getProcessSubDirection,
  ProcessSubDirection,
} from '../../shell/helpers.ts'
import { NodeType as NT, Redirect, RedirectKind } from '../../shell/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { classifyBarePath } from './classify/index.ts'
import { expandNode, unescapeHeredoc } from './node.ts'
import type { ExecuteFn } from './node.ts'
import { lookupVar, type TSNodeLike } from './variable.ts'

// tree-sitter-bash misses bare `$_name` refs preceded by a non-space
// character inside heredoc bodies (they stay literal text instead of
// becoming simple_expansion nodes); this catches them in literal pieces.
const VAR_REF = /(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g

const NUL = String.fromCharCode(0)

function finishHeredocLiteral(text: string, session: Session, callStack: CallStack | null): string {
  let out = text
  if (out.includes('$')) {
    const masked = out.replaceAll('\\\\', NUL)
    const substituted = masked.replace(VAR_REF, (_m, name: string) =>
      lookupVar(name, session, callStack),
    )
    out = substituted.replaceAll(NUL, '\\\\')
  }
  return unescapeHeredoc(out)
}

// Strip leading tabs at each physical line start (`<<-`).
function stripHeredocTabs(text: string, atLineStart: boolean): string {
  const lines = text.split('\n')
  return lines
    .map((line, i) => (i === 0 && !atLineStart ? line : line.replace(/^\t+/, '')))
    .join('\n')
}

/**
 * Structurally expand an unquoted heredoc body.
 *
 * tree-sitter parses expansions inside heredoc_body as named children;
 * the literal text between them (including the leading chunk, which is
 * NOT a named child) is gap-filled from spans. Literal pieces get
 * heredoc backslash escapes and `<<-` tab stripping; expansion nodes
 * route through expandNode.
 */
async function expandHeredocBody(
  redirectNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string> {
  let bodyNode: TSNodeLike | null = null
  let dash = false
  for (const c of redirectNode.children) {
    if (c.type === '<<-') dash = true
    else if (c.type === NT.HEREDOC_BODY) bodyNode = c
  }
  if (bodyNode === null) return ''
  const raw = bodyNode.text
  const base = bodyNode.startIndex ?? 0
  const parts: string[] = []
  let pos = 0
  let atLineStart = true
  for (const child of bodyNode.namedChildren) {
    const pieces: [string, boolean][] = []
    if (child.startIndex !== undefined && child.endIndex !== undefined) {
      pieces.push([raw.slice(pos, child.startIndex - base), true])
      pos = child.endIndex - base
    }
    if (child.type === NT.HEREDOC_CONTENT) {
      pieces.push([child.text, true])
    } else {
      pieces.push([await expandNode(child, session, executeFn, callStack), false])
    }
    for (const [text, literal] of pieces) {
      if (text === '') continue
      if (literal) {
        const stripped = dash ? stripHeredocTabs(text, atLineStart) : text
        parts.push(finishHeredocLiteral(stripped, session, callStack))
        atLineStart = text.endsWith('\n')
      } else {
        parts.push(text)
        atLineStart = false
      }
    }
  }
  const tail = raw.slice(pos)
  if (tail !== '') {
    const stripped = dash ? stripHeredocTabs(tail, atLineStart) : tail
    parts.push(finishHeredocLiteral(stripped, session, callStack))
  }
  let body = parts.join('')
  if (body !== '' && !body.endsWith('\n')) {
    // bash heredoc bodies always end with a newline (see
    // normalizeHeredocBody for the tree-sitter edge this papers over).
    body += '\n'
  }
  return body
}

/**
 * Expand redirect targets: heredoc vars, target words, pipelines.
 *
 * The single expansion path for redirected statements, shared by the
 * executor (which then applies the redirects) and the provision
 * planner (which only costs them). Heredoc/herestring bodies get
 * session variables substituted; file targets are expanded and
 * classified into PathSpec or plain text; the first attached pipeline
 * is detached and returned separately.
 */
export async function expandRedirects(
  redirects: readonly Redirect[],
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  callStack: CallStack | null = null,
): Promise<[Redirect[], TSNodeLike | null]> {
  const expanded: Redirect[] = []
  for (const r of redirects) {
    if (r.kind === RedirectKind.HEREDOC || r.kind === RedirectKind.HERESTRING) {
      let body: unknown = r.target
      const heredocNode = r.targetNode as TSNodeLike | null
      if (
        r.kind === RedirectKind.HEREDOC &&
        r.expandVars &&
        heredocNode !== null &&
        heredocNode.type === NT.HEREDOC_REDIRECT
      ) {
        body = await expandHeredocBody(heredocNode, session, executeFn, callStack)
      } else if (r.kind === RedirectKind.HERESTRING && heredocNode !== null) {
        body = await expandNode(heredocNode, session, executeFn, callStack)
      } else if (typeof body === 'string' && r.expandVars) {
        let s: string = body
        for (const [k, v] of Object.entries(session.env)) {
          s = s.replaceAll('$' + k, v)
        }
        body = s
      }
      expanded.push(
        new Redirect({
          fd: r.fd,
          target: body,
          targetNode: r.targetNode,
          kind: r.kind,
          append: r.append,
          pipeline: r.pipeline,
          expandVars: r.expandVars,
        }),
      )
      continue
    }
    if (typeof r.target === 'number') {
      expanded.push(r)
      continue
    }
    const procSubNode = r.targetNode as TSNodeLike | null
    if (procSubNode !== null && procSubNode.type === NT.PROCESS_SUBSTITUTION) {
      if (
        r.kind === RedirectKind.STDIN &&
        getProcessSubDirection(procSubNode) === ProcessSubDirection.INPUT
      ) {
        // `cmd < <(inner)` — run the inner command and feed its stdout
        // as stdin, reusing the heredoc delivery path.
        const inner = getProcessSubBody(procSubNode)
        let innerData: Uint8Array = new Uint8Array()
        if (inner !== '') {
          const ioPs = await executeFn(inner, {
            sessionId: session.sessionId,
          })
          innerData = await materialize(ioPs.stdout)
        }
        expanded.push(
          new Redirect({
            fd: 0,
            target: innerData,
            kind: RedirectKind.HEREDOC,
            expandVars: false,
          }),
        )
        continue
      }
      // `> >(cmd)` and friends would otherwise classify the procsub
      // text as a literal filename and write silently wrong state;
      // fail loudly like the argv-position check.
      throw new ExitSignal(
        2,
        new TextEncoder().encode('mirage: unsupported: process substitution >(...)\n'),
        null,
        2,
      )
    }
    const targetNode = r.targetNode as TSNodeLike | null
    let targetScope: unknown = r.target
    if (targetNode !== null) {
      const targetStr = await expandNode(targetNode, session, executeFn, callStack)
      targetScope = classifyBarePath(targetStr, registry, session.cwd)
    }
    expanded.push(
      new Redirect({
        fd: r.fd,
        target: targetScope,
        targetNode: r.targetNode,
        kind: r.kind,
        append: r.append,
        pipeline: r.pipeline,
        expandVars: r.expandVars,
      }),
    )
  }
  let pipeNode: TSNodeLike | null = null
  for (const r of expanded) {
    if (r.pipeline !== null && r.pipeline !== undefined) {
      pipeNode = r.pipeline as TSNodeLike
      r.pipeline = null
      break
    }
  }
  return [expanded, pipeNode]
}
