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
import { Redirect, RedirectKind } from '../../shell/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { classifyBarePath } from './classify.ts'
import { expandNode } from './node.ts'
import type { ExecuteFn } from './node.ts'
import type { TSNodeLike } from './variable.ts'

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
      if (typeof body === 'string' && r.expandVars) {
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
