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

import type { Runtime } from '../executor/runtime.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { makeAbortError } from '../abort.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  getCaseItems,
  getCaseWord,
  getDeclarationKeyword,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getPipelineCommands,
  getRedirects,
  getSubshellBody,
  getText,
  getUnsetNames,
  getWhileParts,
} from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { ERREXIT_EXEMPT_TYPES, NodeType as NT } from '../../shell/types.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { type ExecuteFn, expandArith, expandNode } from '../expand/node.ts'
import { evaluateArith } from '../../shell/arith.ts'
import { ArithError } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import {
  handleCase,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import type { DispatchFn } from '../executor/cross_mount.ts'
import {
  handleExport,
  handleLocal,
  handleReadonly,
  handleTest,
  handleUnset,
} from '../executor/builtins/index.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { resolveGlobs } from '../expand/globs.ts'
import { expandTestExpr } from './test_expr.ts'
import { executeProgram } from './program.ts'
import { executeCommand } from './command_dispatch.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export interface ExecuteNodeDeps {
  dispatch: DispatchFn
  registry: MountRegistry
  namespace: Namespace
  jobTable: JobTable | null
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  ensureOpen?: (resource: Resource) => Promise<void>
  unmount?: (prefix: string) => Promise<void>
  runtimeBindings?: Record<string, Runtime>
  signal?: AbortSignal
}

export async function executeNode(
  deps: ExecuteNodeDeps,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const recurse = (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ): Promise<Result> => executeNode(deps, n, s, i, cs)

  const { dispatch, registry, jobTable, executeFn, agentId } = deps
  const kind = nodeKind(node)

  if (deps.signal?.aborted === true) {
    throw makeAbortError()
  }

  if (kind === NodeKind.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (kind === NodeKind.PROGRAM) {
    return executeProgram(recurse, node, session, stdin, callStack, jobTable, agentId)
  }

  if (kind === NodeKind.COMMAND) {
    return executeCommand(
      recurse,
      dispatch,
      registry,
      deps.namespace,
      executeFn,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      deps.ensureOpen,
      deps.unmount,
      deps.runtimeBindings,
      deps.signal,
    )
  }

  if (kind === NodeKind.PIPELINE) {
    const [commands, stderrFlags] = getPipelineCommands(node)
    return handlePipe(recurse, commands, stderrFlags, session, stdin, callStack)
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(recurse, left, op, right, session, stdin, callStack)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    if (command.type === NT.LIST) {
      // tree-sitter hoists a trailing redirect over the whole &&/||
      // list; bash binds it to the last command:
      //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
      // Re-associate and defer target expansion until R runs, so
      // `cd /x && echo hi > f` writes under /x. Compound and subshell
      // bodies keep the whole-body redirect (bash group semantics).
      const [left, op, right] = getListParts(command)
      const wrapped: typeof recurse = async (n, sess, sin, cstack) => {
        if (n !== right) return recurse(n, sess, sin, cstack)
        const [expanded, pipe] = await expandRedirects(redirects, sess, executeFn, registry, cstack)
        let [rStdout, rIo, rExec] = await handleRedirect(
          recurse,
          dispatch,
          right,
          expanded,
          sess,
          sin,
          cstack,
        )
        if (pipe !== null && rStdout !== null) {
          const [s2, io2, e2] = await recurse(pipe, sess, rStdout, cstack)
          rStdout = s2
          rIo = await rIo.merge(io2)
          rExec = e2
        }
        return [rStdout, rIo, rExec]
      }
      return handleConnection(wrapped, left, op, right, session, stdin, callStack)
    }
    const [expandedRedirects, pipeNode] = await expandRedirects(
      redirects,
      session,
      executeFn,
      registry,
      callStack,
    )
    let [stdout, io, execNode] = await handleRedirect(
      recurse,
      dispatch,
      command,
      expandedRedirects,
      session,
      stdin,
      callStack,
    )
    if (pipeNode !== null && stdout !== null) {
      const [stdout2, io2, execNode2] = await recurse(pipeNode, session, stdout, callStack)
      stdout = stdout2
      io = await io.merge(io2)
      execNode = execNode2
    }
    return [stdout, io, execNode]
  }

  if (kind === NodeKind.SUBSHELL) {
    return handleSubshell(recurse, getSubshellBody(node), session, stdin, callStack)
  }

  if (kind === NodeKind.COMPOUND && node.children[0]?.type === NT.ARITH_OPEN) {
    const text = getText(node)
    const expr = await expandArith(node, session, executeFn, callStack)
    let value: bigint
    let updates: Record<string, string>
    try {
      ;({ value, updates } = evaluateArith(expr, session.env))
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      const errBytes = new TextEncoder().encode(`bash: ((: ${expr}: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
      ]
    }
    for (const name of Object.keys(updates)) {
      if (session.readonlyVars.has(name)) {
        const errBytes = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: errBytes }),
        ]
      }
    }
    Object.assign(session.env, updates)
    const code = value !== 0n ? 0 : 1
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: text, exitCode: code }),
    ]
  }

  if (kind === NodeKind.COMPOUND) {
    const allStdout: ByteSource[] = []
    let mergedIo = new IOResult()
    let lastExec = new ExecutionNode({ command: '{}', exitCode: 0 })
    for (const child of node.namedChildren) {
      if (child.type === NT.COMMENT) continue
      const [stdout, io, execNode] = await recurse(child, session, stdin, callStack)
      lastExec = execNode
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(child.type)
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    }
    if (allStdout.length === 1 && allStdout[0] !== undefined) {
      return [allStdout[0], mergedIo, lastExec]
    }
    const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
    return [combined, mergedIo, lastExec]
  }

  if (kind === NodeKind.IF) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(recurse, branches, elseBody, session, stdin, callStack)
  }

  if (kind === NodeKind.FOR || kind === NodeKind.SELECT) {
    const [variable, values, body] = getForParts(node)
    const classified = await expandAndClassify(
      values,
      session,
      executeFn,
      registry,
      session.cwd,
      callStack,
    )
    // The loop word list is consumed by the shell (WordPolicy.SHELL):
    // globs resolve to matches before iteration starts.
    const resolved = await resolveGlobs(classified, registry)
    if (kind === NodeKind.SELECT) {
      return handleSelect(recurse, variable, resolved, body, session, stdin, callStack)
    }
    return handleFor(recurse, variable, resolved, body, session, stdin, callStack)
  }

  if (kind === NodeKind.WHILE || kind === NodeKind.UNTIL) {
    const [condition, body] = getWhileParts(node)
    if (kind === NodeKind.UNTIL) {
      return handleUntil(recurse, condition, body, session, stdin, callStack)
    }
    return handleWhile(recurse, condition, body, session, stdin, callStack)
  }

  if (kind === NodeKind.CASE) {
    const wordNode = getCaseWord(node)
    const word = await expandNode(wordNode, session, executeFn, callStack)
    const items = getCaseItems(node)
    return handleCase(recurse, word, items, session, stdin, callStack)
  }

  if (kind === NodeKind.FUNCTION_DEF) {
    const name = getFunctionName(node)
    const body = getFunctionBody(node)
    session.functions[name] = body
    return [null, new IOResult(), new ExecutionNode({ command: `function ${name}`, exitCode: 0 })]
  }

  if (kind === NodeKind.DECLARATION) {
    const keyword = getDeclarationKeyword(node)
    const assignments: string[] = []
    const flagChars = new Set<string>()
    for (const child of node.namedChildren) {
      if (child.type === NT.VARIABLE_ASSIGNMENT) {
        const valNodes = child.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
        const firstVal = valNodes[0]
        if (firstVal?.type === NT.ARRAY) {
          const text = getText(child)
          const eq = text.indexOf('=')
          const key = eq >= 0 ? text.slice(0, eq) : text
          const items: string[] = []
          for (const ac of firstVal.namedChildren) {
            items.push(await expandNode(ac, session, executeFn, callStack))
          }
          session.arrays[key] = items
          continue
        }
        assignments.push(await expandNode(child, session, executeFn, callStack))
      } else if (
        child.type === NT.SIMPLE_EXPANSION ||
        child.type === NT.EXPANSION ||
        child.type === NT.CONCATENATION ||
        child.type === NT.WORD
      ) {
        const expanded = await expandNode(child, session, executeFn, callStack)
        if (expanded === '') continue
        if (expanded.startsWith('-') && expanded.length > 1) {
          for (const ch of expanded.slice(1)) flagChars.add(ch)
        } else {
          assignments.push(expanded)
        }
      }
    }
    if (keyword === NT.LOCAL) return handleLocal(assignments, session)
    if (keyword === 'readonly' || flagChars.has('r')) {
      return handleReadonly(assignments, session)
    }
    return handleExport(assignments, session)
  }

  if (kind === NodeKind.UNSET) {
    return handleUnset(getUnsetNames(node), session)
  }

  if (kind === NodeKind.TEST) {
    const expanded = await expandTestExpr(node, session, executeFn, callStack)
    return handleTest(dispatch, expanded, session)
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    const [stdout, io, execNode] = await recurse(inner, session, stdin, callStack)
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.VAR_ASSIGN) {
    const text = getText(node)
    if (text.includes('=')) {
      const eq = text.indexOf('=')
      const key = text.slice(0, eq)
      let val = text.slice(eq + 1)
      if (session.readonlyVars.has(key)) {
        const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: text, exitCode: 1, stderr: err }),
        ]
      }
      const valNodes = node.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
      const firstVal = valNodes[0]
      if (firstVal?.type === NT.ARRAY) {
        const items: string[] = []
        for (const ac of firstVal.namedChildren) {
          items.push(await expandNode(ac, session, executeFn, callStack))
        }
        session.arrays[key] = items
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.env[key]
        return [null, new IOResult(), new ExecutionNode({ command: text, exitCode: 0 })]
      }
      if (firstVal !== undefined) {
        val = await expandNode(firstVal, session, executeFn, callStack)
      }
      session.env[key] = val
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.arrays[key]
    }
    return [null, new IOResult(), new ExecutionNode({ command: text, exitCode: 0 })]
  }

  // Constructs the parser accepts but the executor cannot honor (e.g.
  // C-style `for ((;;))`). Mirrors the unsupported-builtin diagnostic
  // so agents see a capability gap, not a crash.
  const unsupportedErr = new TextEncoder().encode(
    `mirage: unsupported shell construct: ${node.type}\n`,
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: unsupportedErr }),
    new ExecutionNode({ command: node.text, exitCode: 2, stderr: unsupportedErr }),
  ]
}
