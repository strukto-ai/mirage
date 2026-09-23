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
  getCforParts,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getParts,
  getPipelineCommands,
  getRedirects,
  takeContinuation,
  getSubshellBody,
  getText,
  getWhileParts,
  hasCommandSubstitution,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import {
  NodeType as NT,
  type Redirect,
  RedirectKind,
  ShellBuiltin as SB,
} from '../../shell/types.ts'
import { Precision, ProvisionResult } from '../../provision/types.ts'
import { rollupList, rollupPipe } from '../../provision/rollup.ts'
import { PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { classifyParts } from '../expand/classify/index.ts'
import type { ExecuteFn } from '../expand/node.ts'
import { expandAndClassify, expandParts } from '../expand/parts.ts'
import { expandRedirects } from '../expand/redirects.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import { gate } from './admission.ts'
import { handleCommandProvision } from '../provision/command.ts'
import {
  handleForProvision,
  handleFunctionProvision,
  handleIfProvision,
  handleWhileProvision,
} from '../provision/control.ts'
import { handleConnectionProvision, handlePipeProvision } from '../provision/pipes.ts'
import { handleRedirectProvision } from '../provision/redirect.ts'
import type { SessionState } from '../session/session.ts'

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
  SB.GETOPTS,
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
  agentId?: string
}

/**
 * Walk-local planner state. Function definitions seen during this
 * plan are recorded here (not on the session: planning must not
 * mutate shell state), and `planning` guards recursive functions
 * from looping the planner. `gated` hands the REDIRECT arm's
 * admission verdict (its classified words, keyed by the command
 * node) to the inner COMMAND arm: the run admits a redirected
 * command once, with its targets, so the plan must not consult
 * `preCommand` a second time for the same statement. Each entry is
 * deleted by the recursion that consumes it.
 */
interface PlanScope {
  functions: Map<string, TSNodeLike[]>
  planning: Set<string>
  gated: Map<TSNodeLike, (string | PathSpec)[]>
}

// Plan one redirected command: expand targets, cost, degrade. A cmdsub
/**
 * Ask the run's own admission about one COMMAND node before any of it
 * is planned.
 *
 * The executor admits every command class at one chokepoint — shell
 * builtins, functions, and mount commands alike, with the statement's
 * redirect targets judged on the same call (`runArgv`) — so the plan
 * walk asks the same question in the same place: ahead of the function
 * and builtin arms, and with the redirect targets when the REDIRECT
 * arm is the caller. A dry run stats and lists to estimate, and a
 * refused command's byte counts are exactly what the refusal is
 * protecting, so a command the chain would deny — or would hold for an
 * approval no dry run can obtain — plans as an honest UNKNOWN before
 * anything prices it. `gate` is the dry-run half of `admit` (no
 * request recorded, no grant consumed, no ask raised). One residual,
 * deliberate: the estimator's own backend reads run against the
 * accessor directly, so `preOps` rules do not see them. A name the
 * walk's own script defines is vouched visible (`assumeVisible`): the
 * run stores that function in the session before the call, the dry run
 * keeps it in plan state.
 *
 * Returns `[refusal, classified]`: the honest UNKNOWN plan when the
 * gate refuses, else null, beside the classified words that feed the
 * mount-command estimate.
 */
async function gateCommand(
  ctx: ProvisionContext,
  name: string,
  parts: TSNodeLike[],
  session: SessionState,
  planScope: PlanScope,
  redirects: readonly PathSpec[] = [],
): Promise<[ProvisionResult | null, (string | PathSpec)[]]> {
  const expanded = await expandParts(parts, session, ctx.executeFn)
  const classified = classifyParts(expanded, ctx.registry, session.cwd)
  const head = classified[0]
  const cmdName = head === undefined ? name : head instanceof PathSpec ? head.virtual : head
  const cmdArgs = classified.slice(1).map((p) => (p instanceof PathSpec ? p.virtual : p))
  const verdict = await gate(
    cmdName,
    cmdArgs,
    classified.slice(1),
    session,
    ctx.registry,
    ctx.namespace ?? null,
    ctx.agentId ?? '',
    null,
    redirects,
    planScope.functions.has(name), // definedFn: the walk vouches its own definitions
  )
  if (!Array.isArray(verdict) || verdict[1] !== null) {
    return [
      new ProvisionResult({
        command: [cmdName, ...cmdArgs].join(' '),
        precision: Precision.UNKNOWN,
      }),
      classified,
    ]
  }
  return [null, classified]
}

// target expands empty under provision, so its classification is
// garbage; the precision degrade keeps the plan honest without costing
// a phantom write.
async function provisionRedirected(
  ctx: ProvisionContext,
  recurse: (n: TSNodeLike, s: SessionState) => Promise<ProvisionResult>,
  recurseUnknown: (n: unknown, s: SessionState) => Promise<ProvisionResult>,
  planScope: PlanScope,
  command: unknown,
  redirects: Redirect[],
  session: SessionState,
): Promise<ProvisionResult> {
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
    if (r.targetNode !== null && hasCommandSubstitution(r.targetNode as TSNodeLike)) {
      continue
    }
    targets.push([r.kind, r.target])
  }
  // The run judges redirect targets on the same admit call as the
  // command ("their I/O runs on the shell's own fds"), so the plan
  // gates them together too, before a `< file` source is priced as a
  // read: a refused `read < /secret` must not stat the secret. Only a
  // plain COMMAND node gates here; a compound's inner commands each
  // gate on their own recursion.
  if (
    command !== null &&
    command !== undefined &&
    nodeKind(command as TSNodeLike) === NodeKind.COMMAND
  ) {
    const cmdNode = command as TSNodeLike
    const name = getCommandName(cmdNode)
    const [, cmdParts] = splitEnvPrefix(getParts(cmdNode))
    if (cmdParts.length > 0) {
      const [refusal, classified] = await gateCommand(
        ctx,
        name,
        cmdParts,
        session,
        planScope,
        targets.map(([, t]) => t),
      )
      if (refusal !== null) return refusal
      // This verdict, judged with its redirects, covers the whole
      // statement: the recursion below re-plans the same COMMAND node,
      // and it consumes this instead of consulting `preCommand` a
      // second time for one command.
      planScope.gated.set(cmdNode, classified)
    }
  }
  const result = await handleRedirectProvision(
    recurseUnknown,
    ctx.registry,
    command,
    targets,
    session,
    ctx.namespace ?? null,
  )
  if (
    redirects.some(
      (r) =>
        r.kind !== RedirectKind.HEREDOC &&
        r.kind !== RedirectKind.HERESTRING &&
        r.targetNode !== null &&
        hasCommandSubstitution(r.targetNode as TSNodeLike),
    )
  ) {
    // A suppressed substitution hid the real redirect target (heredoc
    // bodies carry their node too, but their target is stdin, not a
    // hidden file).
    result.precision = Precision.UNKNOWN
  }
  if (pipeNode !== null) {
    return rollupPipe([result, await recurse(pipeNode, session)])
  }
  return result
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
  session: SessionState,
  scope?: PlanScope,
): Promise<ProvisionResult> {
  const planScope: PlanScope = scope ?? {
    functions: new Map(),
    planning: new Set(),
    gated: new Map(),
  }
  const recurse = (n: TSNodeLike, s: SessionState): Promise<ProvisionResult> =>
    provisionNode(ctx, n, s, planScope)
  const recurseUnknown = (n: unknown, s: SessionState): Promise<ProvisionResult> =>
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
    const [, parts] = splitEnvPrefix(getParts(node))
    if (parts.length === 0) return new ProvisionResult({ precision: Precision.EXACT })
    // The gate fires ahead of the function and builtin arms, mirroring
    // the executor's chokepoint: a denied function must not have its
    // body walked, and a denied builtin must not come back as an
    // admitted-looking EXACT plan. A REDIRECT arm that already admitted
    // this very node (with its targets) hands its verdict down instead
    // of a second `preCommand` consultation.
    let classified = planScope.gated.get(node)
    if (classified !== undefined) {
      planScope.gated.delete(node)
    } else {
      const [refusal, gatedWords] = await gateCommand(ctx, name, parts, session, planScope)
      if (refusal !== null) return refusal
      classified = gatedWords
    }
    const funcBody =
      planScope.functions.get(name) ?? (session.functions[name] as TSNodeLike[] | undefined)
    if (funcBody !== undefined) {
      return handleFunctionProvision(recurseUnknown, name, funcBody, planScope.planning, session)
    }
    if (BUILTIN_NAMES.has(name)) return handleBuiltinProvision()
    const result = await handleCommandProvision(
      ctx.registry,
      classified,
      session,
      ctx.namespace ?? null,
    )
    if (parts.some((p) => hasCommandSubstitution(p))) {
      // The plan walk suppressed the substitution, so the operand list
      // is incomplete: the totals are floors, not answers.
      result.precision = Precision.UNKNOWN
    }
    return result
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
    const continuation = takeContinuation(redirects)
    let plan: ProvisionResult
    if (command !== null && (command as TSNodeLike & { type: string }).type === NT.LIST) {
      // Mirror the executor: a trailing redirect hoisted over an
      // &&/|| list binds to the last command.
      const [left, op, right] = getListParts(command)
      const wrapped = (n: unknown, s: SessionState): Promise<ProvisionResult> =>
        n === right
          ? provisionRedirected(ctx, recurse, recurseUnknown, planScope, right, redirects, s)
          : recurseUnknown(n, s)
      plan = await handleConnectionProvision(wrapped, left, op ?? '&&', right, session)
    } else {
      plan = await provisionRedirected(
        ctx,
        recurse,
        recurseUnknown,
        planScope,
        command,
        redirects,
        session,
      )
    }
    // Mirror the executor again: the `&&`/`||` steps a heredoc's operator
    // line carried wrap the whole statement, so each one joins the plan
    // so far to its right operand.
    for (const [op, right] of continuation) {
      const planned = plan
      const wrapped = (n: unknown, s: SessionState): Promise<ProvisionResult> =>
        n === node ? Promise.resolve(planned) : recurseUnknown(n, s)
      plan = await handleConnectionProvision(wrapped, node, op, right, session)
    }
    return plan
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIfProvision(recurseUnknown, branches, elseBody, session)
  }

  if (kind === NodeKind.FOR) {
    const [, values, body] = getForParts(node)
    if (values.some((v) => hasCommandSubstitution(v))) {
      // The iteration count comes from a suppressed substitution: plan
      // one pass as a floor and degrade.
      const result = await handleForProvision(recurseUnknown, body, 1, session)
      result.precision = Precision.UNKNOWN
      return result
    }
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

  if (kind === NodeKind.CFOR) {
    // The iteration count comes from arithmetic: unbounded like while.
    const [, body] = getCforParts(node)
    return handleWhileProvision(recurseUnknown, body, session)
  }

  if (kind === NodeKind.CASE) {
    const items = getCaseItems(node)
    const children: ProvisionResult[] = []
    for (const [, body] of items) {
      if (body.length === 0) continue
      const stmts: ProvisionResult[] = []
      for (const stmt of body) stmts.push(await recurse(stmt, session))
      const first = stmts[0]
      children.push(stmts.length === 1 && first !== undefined ? first : rollupList(';', stmts))
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
    kind === NodeKind.VAR_ASSIGN ||
    kind === NodeKind.VAR_ASSIGNS
  ) {
    return handleBuiltinProvision()
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    return recurse(inner, session)
  }

  return new ProvisionResult({ command: getText(node), precision: Precision.UNKNOWN })
}
