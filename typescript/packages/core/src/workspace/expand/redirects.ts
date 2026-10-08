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
import { childLine } from './node.ts'
import type { SessionView } from '../../view/types.ts'
import { materialize } from '../../io/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { getProcessSubBody, getProcessSubDirection } from '../../shell/helpers.ts'
import { NodeType as NT, ProcessSubDirection, Redirect, RedirectKind } from '../../shell/types.ts'
import type { MountRegistry } from '../mount/registry.ts'

import { visibleEnv } from '../session/state.ts'
import { classifyBarePath } from './classify/index.ts'
import { expandNode } from './node.ts'
import type { ExecuteFn } from './node.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { encodeText } from '../../shell/bytes.ts'

/**
 * Expand redirect targets: heredoc vars, target words, pipelines.
 *
 * The single expansion path for redirected statements; the executor
 * then applies the redirects. Heredoc/herestring bodies get
 * session variables substituted; file targets are expanded and
 * classified into PathSpec or plain text; the first attached pipeline
 * is detached and returned separately. `forked` says the redirects belong
 * to a program bash forks for, which expands them in the child: an error
 * there is kept for the command to fail on (`UNEXPANDED`) rather than
 * thrown into the shell, which discards the line.
 */
export async function expandRedirects(
  redirects: readonly Redirect[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  callStack: CallStack | null = null,
  view?: SessionView,
  forked = false,
): Promise<[Redirect[], TSNodeLike | null]> {
  const expanded: Redirect[] = []
  for (const [index, r] of redirects.entries()) {
    try {
      expanded.push(await expandRedirect(r, context, executeFn, registry, callStack, view))
    } catch (err) {
      if (!(err instanceof ExitSignal) || !forked) throw err
      // The child performs no redirect after the first that fails; a
      // pipeline the line attached to one of them still runs.
      const later = redirects.slice(index).find((each) => each.pipeline != null)
      expanded.push(
        new Redirect({
          fd: r.fd,
          target: err,
          kind: RedirectKind.UNEXPANDED,
          pipeline: later?.pipeline ?? null,
        }),
      )
      break
    }
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

/** Expand one redirect's body or target. */
async function expandRedirect(
  r: Redirect,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  callStack: CallStack | null,
  view: SessionView | undefined,
): Promise<Redirect> {
  const session = context.session
  if (r.kind === RedirectKind.HEREDOC || r.kind === RedirectKind.HERESTRING) {
    let body: unknown = r.target
    const heredocNode = r.targetNode as TSNodeLike | null
    if (r.expandVars && heredocNode !== null) {
      body = await expandNode(heredocNode, context, executeFn, callStack, view)
    } else if (typeof body === 'string' && r.expandVars) {
      let s: string = body
      for (const [k, v] of Object.entries(visibleEnv(session))) {
        s = s.replaceAll('$' + k, v)
      }
      body = s
    }
    return new Redirect({
      fd: r.fd,
      target: body,
      targetNode: r.targetNode,
      kind: r.kind,
      append: r.append,
      clobber: r.clobber,
      pipeline: r.pipeline,
      expandVars: r.expandVars,
      continuation: r.continuation,
    })
  }
  if (typeof r.target === 'number') return r
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
        const ioPs = await childLine(context, executeFn, inner, procSubNode, callStack)
        innerData = await materialize(ioPs.stdout)
        context.frame.diagnostics.push(await ioPs.materializeStderr())
      }
      return new Redirect({
        fd: r.fd,
        target: innerData,
        kind: RedirectKind.HEREDOC,
        expandVars: false,
      })
    }
    // `> >(cmd)` and friends would otherwise classify the procsub
    // text as a literal filename and write silently wrong state;
    // fail loudly like the argv-position check.
    throw new ExitSignal(
      2,
      encodeText('mirage: unsupported: process substitution >(...)\n'),
      null,
      2,
    )
  }
  const targetNode = r.targetNode as TSNodeLike | null
  let targetScope: unknown = r.target
  if (targetNode !== null) {
    const targetStr = await expandNode(targetNode, context, executeFn, callStack, view)
    targetScope = classifyBarePath(targetStr, registry, session.cwd)
  }
  return new Redirect({
    fd: r.fd,
    target: targetScope,
    targetNode: r.targetNode,
    kind: r.kind,
    append: r.append,
    clobber: r.clobber,
    pipeline: r.pipeline,
    expandVars: r.expandVars,
    continuation: r.continuation,
  })
}
