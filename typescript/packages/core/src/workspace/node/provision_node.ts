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

import {
  getCaseItems,
  getCommandName,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getParts,
  getPipelineCommands,
  getRedirects,
  getSubshellBody,
  getText,
  getWhileParts,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import { NodeType as NT, RedirectKind, ShellBuiltin as SB } from '../../shell/types.ts'
import { Precision, ProvisionResult } from '../../provision/types.ts'
import { rollupList, rollupPipe } from '../../provision/rollup.ts'
import { PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { classifyParts } from '../expand/classify.ts'
import type { ExecuteFn } from '../expand/node.ts'
import { expandAndClassify, expandParts } from '../expand/parts.ts'
import { expandRedirects } from '../expand/redirects.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace.ts'
import { handleCommandProvision } from '../provision/command.ts'
import {
  handleForProvision,
  handleFunctionProvision,
  handleIfProvision,
  handleWhileProvision,
} from '../provision/control.ts'
import { handleConnectionProvision, handlePipeProvision } from '../provision/pipes.ts'
import { handleRedirectProvision } from '../provision/redirect.ts'
import type { Session } from '../session/session.ts'

// eval / source execute their payload, so they are NOT free builtins:
// leaving them out lets them fall through to command resolution, which
// honestly reports UNKNOWN instead of a zero-cost EXACT.
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  SB.CD,
  SB.TRUE,
  SB.FALSE,
  SB.EXPORT,
  SB.UNSET,
  SB.LOCAL,
  SB.PRINTENV,
  SB.READ,
  SB.SET,
  SB.SHIFT,
  SB.TRAP,
  SB.TEST,
  SB.BRACKET,
  SB.DOUBLE_BRACKET,
  SB.WAIT,
  SB.FG,
  SB.KILL,
  SB.JOBS,
  SB.PS,
  SB.ECHO,
  SB.PRINTF,
  SB.SLEEP,
  SB.RETURN,
  SB.BREAK,
  SB.CONTINUE,
])

function handleBuiltinProvision(): ProvisionResult {
  return new ProvisionResult({ precision: Precision.EXACT })
}

interface ProvisionContext {
  registry: MountRegistry
  executeFn: ExecuteFn
  namespace?: Namespace | null
}

/**
 * Walk-local planner state. Function definitions seen during this
 * plan are recorded here (not on the session: planning must not
 * mutate shell state), and `planning` guards recursive functions
 * from looping the planner.
 */
interface PlanScope {
  functions: Map<string, TSNodeLike[]>
  planning: Set<string>
}

/**
 * Walk tree-sitter AST and estimate execution cost.
 *
 * Dispatches on the same NodeKind classification as the executor
 * (`shell/node_kind.ts`), so every construct the executor runs has a
 * planner branch; kinds neither walker supports fall through to an
 * honest UNKNOWN.
 */
export async function provisionNode(
  ctx: ProvisionContext,
  node: TSNodeLike | null | undefined,
  session: Session,
  scope?: PlanScope,
): Promise<ProvisionResult> {
  const planScope: PlanScope = scope ?? { functions: new Map(), planning: new Set() }
  const recurse = (n: TSNodeLike, s: Session): Promise<ProvisionResult> =>
    provisionNode(ctx, n, s, planScope)
  const recurseUnknown = (n: unknown, s: Session): Promise<ProvisionResult> =>
    recurse(n as TSNodeLike, s)
  if (node === null || node === undefined) {
    return new ProvisionResult({ precision: Precision.EXACT })
  }
  const kind = nodeKind(node)

  if (kind === NodeKind.COMMENT) {
    return new ProvisionResult({ precision: Precision.EXACT })
  }

  if (kind === NodeKind.PROGRAM || kind === NodeKind.SUBSHELL || kind === NodeKind.COMPOUND) {
    const body =
      kind === NodeKind.SUBSHELL
        ? getSubshellBody(node)
        : node.namedChildren.filter((c) => c.type !== NT.COMMENT)
    const children: ProvisionResult[] = []
    for (const c of body) children.push(await recurse(c, session))
    if (children.length === 0) return new ProvisionResult({ precision: Precision.EXACT })
    return rollupList(';', children)
  }

  if (kind === NodeKind.COMMAND) {
    const name = getCommandName(node)
    const funcBody =
      planScope.functions.get(name) ?? (session.functions[name] as TSNodeLike[] | undefined)
    if (funcBody !== undefined) {
      return handleFunctionProvision(recurseUnknown, name, funcBody, planScope.planning, session)
    }
    if (BUILTIN_NAMES.has(name)) return handleBuiltinProvision()
    const [, parts] = splitEnvPrefix(getParts(node))
    if (parts.length === 0) return new ProvisionResult({ precision: Precision.EXACT })
    const expanded = await expandParts(parts, session, ctx.executeFn)
    const classified = classifyParts(expanded, ctx.registry, session.cwd)
    return handleCommandProvision(ctx.registry, classified, session, ctx.namespace ?? null)
  }

  if (kind === NodeKind.PIPELINE) {
    const [commands] = getPipelineCommands(node)
    return handlePipeProvision(recurseUnknown, commands, session)
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnectionProvision(recurseUnknown, left, op ?? '&&', right, session)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    const [expanded, pipeNode] = await expandRedirects(
      redirects,
      session,
      ctx.executeFn,
      ctx.registry,
    )
    const targets: [RedirectKind, PathSpec][] = []
    for (const r of expanded) {
      if (r.kind !== RedirectKind.STDIN && r.kind !== RedirectKind.STDOUT) continue
      if (!(r.target instanceof PathSpec)) continue
      if (r.target.virtual.startsWith('/dev/')) continue
      targets.push([r.kind, r.target])
    }
    const result = await handleRedirectProvision(
      recurseUnknown,
      ctx.registry,
      command,
      targets,
      session,
      ctx.namespace ?? null,
    )
    if (pipeNode !== null) {
      return rollupPipe([result, await recurse(pipeNode, session)])
    }
    return result
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIfProvision(recurseUnknown, branches, elseBody, session)
  }

  if (kind === NodeKind.FOR) {
    const [, values, body] = getForParts(node)
    const classified = await expandAndClassify(
      values,
      session,
      ctx.executeFn,
      ctx.registry,
      session.cwd,
    )
    const n = classified.length || 1
    return handleForProvision(recurseUnknown, body, n, session)
  }

  if (kind === NodeKind.SELECT) {
    // select re-prompts until break: unbounded like while.
    const [, , body] = getForParts(node)
    return handleWhileProvision(recurseUnknown, body, session)
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [, body] = getWhileParts(node)
    return handleWhileProvision(recurseUnknown, body, session)
  }

  if (kind === NodeKind.CASE) {
    const items = getCaseItems(node)
    const children: ProvisionResult[] = []
    for (const [, body] of items) {
      if (body !== null) children.push(await recurse(body, session))
    }
    if (children.length > 0) return rollupList('||', children)
    return new ProvisionResult({ precision: Precision.EXACT })
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    const body = getFunctionBody(node)
    if (name !== '' && body !== null) planScope.functions.set(name, body)
    return handleBuiltinProvision()
  }

  if (
    kind === NodeKind.DECLARATION ||
    kind === NodeKind.UNSET ||
    kind === NodeKind.TEST ||
    kind === NodeKind.VAR_ASSIGN
  ) {
    return handleBuiltinProvision()
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    return recurse(inner, session)
  }

  return new ProvisionResult({ command: getText(node), precision: Precision.UNKNOWN })
}
