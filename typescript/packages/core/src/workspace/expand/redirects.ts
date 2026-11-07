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

import { sessionAccess } from '../../context/session_context.ts'
import type { EvaluationContext } from '../evaluation.ts'
import type { Policies } from '../../policy/index.ts'
import type { NamespaceLinks } from '../../view/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { Redirect, RedirectKind } from '../../shell/types.ts'
import type { MountRegistry } from '../mount/registry.ts'

import { classifyBarePath } from './classify/index.ts'
import { globOptions, resolveGlobs } from './globs.ts'
import { expandWords } from './parts.ts'
import { expandNode } from './node.ts'
import type { ExecuteFn } from './types.ts'
import type { TSNodeLike } from '../../shell/types.ts'

/** Expand one redirect immediately before the executor applies it. */
export async function expandRedirect(
  redirect: Redirect,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
  forked = false,
  links: NamespaceLinks | null = null,
  // The target's words when another shell expanded them already (`$(< file)`),
  // glob marks kept; null expands the target here.
  words: readonly string[] | null = null,
): Promise<Redirect> {
  try {
    return await expandTarget(
      redirect,
      context,
      executeFn,
      registry,
      callStack,
      policies,
      links,
      words,
    )
  } catch (error) {
    if (!(error instanceof ExitSignal) || !forked) throw error
    return new Redirect({ fd: redirect.fd, target: error, kind: RedirectKind.UNEXPANDED })
  }
}

/** Expand one redirect's body or target. */
async function expandTarget(
  r: Redirect,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  callStack: CallStack | null,
  policies: Policies | null,
  links: NamespaceLinks | null,
  expanded: readonly string[] | null,
): Promise<Redirect> {
  const session = context.session
  if (r.kind === RedirectKind.HEREDOC || r.kind === RedirectKind.HERESTRING) {
    let body: unknown = r.target
    const heredocNode = r.targetNode as TSNodeLike | null
    if (r.expandVars && heredocNode !== null) {
      body = await expandNode(heredocNode, context, executeFn, callStack, policies)
    }
    return new Redirect({
      fd: r.fd,
      target: body,
      targetNode: r.targetNode,
      kind: r.kind,
      append: r.append,
      clobber: r.clobber,
      expandVars: r.expandVars,
    })
  }
  if (typeof r.target === 'number') return r
  const targetNode = r.targetNode as TSNodeLike | null
  let targetScope: unknown = r.target
  if (targetNode !== null) {
    const words =
      expanded ?? (await expandWords([targetNode], context, executeFn, callStack, policies))
    const targets = await resolveGlobs(
      words.map((word) => classifyBarePath(word, registry, session.cwd, sessionAccess(session))),
      registry,
      session.shellOptions.noglob ?? false,
      links,
      globOptions(session),
    )
    if (targets.length !== 1) {
      return new Redirect({
        fd: r.fd,
        target: r.target,
        targetNode: r.targetNode,
        kind: RedirectKind.AMBIGUOUS,
      })
    }
    targetScope = targets[0]
  }
  return new Redirect({
    fd: r.fd,
    target: targetScope,
    targetNode: r.targetNode,
    kind: r.kind,
    append: r.append,
    clobber: r.clobber,
    expandVars: r.expandVars,
  })
}
