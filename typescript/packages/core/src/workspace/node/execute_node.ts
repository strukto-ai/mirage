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

import type { CommandHistory } from '../../commands/config.ts'
import { OperandKind, type CommandSpec } from '../../commands/spec/types.ts'
import { asyncChain } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { makeAbortError } from '../abort.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  getCaseItems,
  getCaseWord,
  getCommandName,
  getDeclarationKeyword,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getParts,
  getPipelineCommands,
  getProcessSubDirection,
  ProcessSubDirection,
  getRedirects,
  getSubshellBody,
  getText,
  getUnsetNames,
  getWhileParts,
} from '../../shell/helpers.ts'
import type { PyodideRuntime } from '../executor/python/runtime.ts'
import type { JobTable } from '../../shell/job_table.ts'
import {
  ERREXIT_EXEMPT_TYPES,
  NodeType as NT,
  Redirect,
  RedirectKind as Redirect_,
  ShellBuiltin as SB,
} from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import { classifyBarePath, classifyParts } from '../expand/classify.ts'
import type { ExecuteFn } from '../expand/node.ts'
import { expandNode } from '../expand/node.ts'
import { expandAndClassify, expandParts } from '../expand/parts.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { handleCommand } from '../executor/command.ts'
import {
  BreakSignal,
  ContinueSignal,
  handleCase,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import type { DispatchFn } from '../executor/cross_mount.ts'
import {
  handleBash,
  handleCd,
  handleEcho,
  handleEval,
  handleExport,
  handleLocal,
  handleMan,
  handlePrintenv,
  handlePrintf,
  handleRead,
  handleReadonly,
  handleReturn,
  handleSet,
  handleShift,
  handleSleep,
  handleSource,
  handleTest,
  handleTrap,
  handleUnset,
  handleWhoami,
} from '../executor/builtins.ts'
import { handleBackground } from '../executor/jobs.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { resolveGlobs } from './resolve_globs.ts'
import { expandTestExpr } from './test_expr.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const UNSUPPORTED_BUILTINS: ReadonlySet<string> = new Set([
  'bg',
  'disown',
  'exec',
  'complete',
  'compgen',
  'ulimit',
])

export interface ExecuteNodeDeps {
  dispatch: DispatchFn
  registry: MountRegistry
  jobTable: JobTable | null
  executeFn: ExecuteFn
  agentId: string
  workspaceId: string
  registerCloser: (fn: () => Promise<void>) => void
  ensureOpen?: (resource: Resource) => Promise<void>
  unmount?: (prefix: string) => Promise<void>
  pythonRuntime?: PyodideRuntime
  history?: CommandHistory
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
  const ntype = node.type

  if (deps.signal?.aborted === true) {
    throw makeAbortError()
  }

  if (ntype === NT.COMMENT) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  if (ntype === NT.PROGRAM) {
    return executeProgram(recurse, node, session, stdin, callStack, jobTable, agentId)
  }

  if (ntype === NT.COMMAND) {
    return executeCommand(
      recurse,
      dispatch,
      registry,
      executeFn,
      node,
      session,
      stdin,
      callStack,
      jobTable,
      deps.ensureOpen,
      deps.unmount,
      deps.pythonRuntime,
      deps.history,
      deps.signal,
    )
  }

  if (ntype === NT.PIPELINE) {
    const [commands, stderrFlags] = getPipelineCommands(node)
    return handlePipe(recurse, commands, stderrFlags, session, stdin, callStack)
  }

  if (ntype === NT.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(recurse, left, op, right, session, stdin, callStack)
  }

  if (ntype === NT.REDIRECTED_STATEMENT) {
    const [command, redirects] = getRedirects(node)
    const expandedRedirects: Redirect[] = []
    for (const r of redirects) {
      if (r.kind === Redirect_.HEREDOC || r.kind === Redirect_.HERESTRING) {
        let body: unknown = r.target
        if (typeof body === 'string' && r.expandVars) {
          let s: string = body
          for (const [k, v] of Object.entries(session.env)) {
            s = s.replaceAll('$' + k, v)
          }
          body = s
        }
        expandedRedirects.push(
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
        expandedRedirects.push(r)
        continue
      }
      const targetNode = r.targetNode as TSNodeLike | null
      let targetScope: unknown = r.target
      if (targetNode !== null) {
        const targetStr = await expandNode(targetNode, session, executeFn, callStack)
        targetScope = classifyBarePath(targetStr, registry, session.cwd)
      }
      expandedRedirects.push(
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
    for (const r of expandedRedirects) {
      if (r.pipeline !== null && r.pipeline !== undefined) {
        pipeNode = r.pipeline as TSNodeLike
        r.pipeline = null
        break
      }
    }
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

  if (ntype === NT.SUBSHELL) {
    return handleSubshell(recurse, getSubshellBody(node), session, stdin, callStack)
  }

  if (ntype === NT.COMPOUND_STATEMENT) {
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

  if (ntype === NT.IF_STATEMENT) {
    const [branches, elseBody] = getIfBranches(node)
    return handleIf(recurse, branches, elseBody, session, stdin, callStack)
  }

  if (ntype === NT.FOR_STATEMENT) {
    const [variable, values, body] = getForParts(node)
    const classified = await expandAndClassify(
      values,
      session,
      executeFn,
      registry,
      session.cwd,
      callStack,
    )
    const resolved = await resolveGlobs(classified, registry)
    if (node.children[0]?.type === NT.SELECT) {
      return handleSelect(recurse, variable, resolved, body, session, stdin, callStack)
    }
    return handleFor(recurse, variable, resolved, body, session, stdin, callStack)
  }

  if (ntype === NT.WHILE_STATEMENT) {
    const [condition, body] = getWhileParts(node)
    if (node.children[0]?.type === NT.UNTIL) {
      return handleUntil(recurse, condition, body, session, stdin, callStack)
    }
    return handleWhile(recurse, condition, body, session, stdin, callStack)
  }

  if (ntype === NT.CASE_STATEMENT) {
    const wordNode = getCaseWord(node)
    const word = await expandNode(wordNode, session, executeFn, callStack)
    const items = getCaseItems(node)
    return handleCase(recurse, word, items, session, stdin, callStack)
  }

  if (ntype === NT.FUNCTION_DEFINITION) {
    const name = getFunctionName(node)
    const body = getFunctionBody(node)
    session.functions[name] = body
    return [null, new IOResult(), new ExecutionNode({ command: `function ${name}`, exitCode: 0 })]
  }

  if (ntype === NT.DECLARATION_COMMAND) {
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

  if (ntype === NT.UNSET_COMMAND) {
    return handleUnset(getUnsetNames(node), session)
  }

  if (ntype === NT.TEST_COMMAND) {
    const expanded = await expandTestExpr(node, session, executeFn, callStack)
    return handleTest(dispatch, expanded, session)
  }

  if (ntype === NT.NEGATED_COMMAND) {
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

  if (ntype === NT.VARIABLE_ASSIGNMENT) {
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

  throw new TypeError(`unsupported tree-sitter node type: ${ntype}`)
}

async function executeProgram(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  agentId: string,
): Promise<Result> {
  const children = node.children
  const allStdout: ByteSource[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '', exitCode: 0 })

  let i = 0
  while (i < children.length) {
    const child = children[i]
    if (child === undefined) {
      i += 1
      continue
    }
    if (child.isNamed !== true || child.type === NT.COMMENT) {
      i += 1
      continue
    }
    if (child.type === NT.ERROR) {
      // ERROR nodes that contain only stray statement separators (`& ;`)
      // are filtered out at parse-time by findSyntaxError, so anything
      // reaching here is a recovered fragment we deliberately skip;
      // structural errors would have raised before executeNode ran.
      i += 1
      continue
    }

    const next = children[i + 1]
    const isBg = next?.type === NT.BACKGROUND

    let stdout: ByteSource | null
    let io: IOResult
    if (isBg) {
      const [bgStdout, bgIo, bgExec] = await handleBackground(
        recurse,
        child,
        null,
        session,
        jobTable,
        agentId,
        stdin,
        callStack,
      )
      stdout = bgStdout
      io = bgIo
      lastExec = bgExec
      i += 2
    } else {
      const [s, ioResult, execNode] = await recurse(child, session, stdin, callStack)
      stdout = await materialize(s)
      ioResult.syncExitCode()
      session.lastExitCode = ioResult.exitCode
      io = ioResult
      lastExec = execNode
      i += 1
    }

    if (stdout !== null) allStdout.push(stdout)
    mergedIo = await mergedIo.merge(io)

    if (
      io.exitCode !== 0 &&
      session.shellOptions.errexit === true &&
      !isBg &&
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

async function executeCommand(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  session: Session,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  unmount?: (prefix: string) => Promise<void>,
  pythonRuntime?: PyodideRuntime,
  history?: CommandHistory,
  signal?: AbortSignal,
): Promise<Result> {
  const name = getCommandName(node)
  const rawParts = getParts(node)

  const prefixAssignments: [string, string][] = []
  const nonPrefixParts: TSNodeLike[] = []
  let sawCommandName = false
  for (const p of rawParts) {
    if (!sawCommandName && p.type === NT.VARIABLE_ASSIGNMENT) {
      const atext = getText(p)
      const eq = atext.indexOf('=')
      if (eq >= 0) {
        const key = atext.slice(0, eq)
        const rawVal = atext.slice(eq + 1)
        const valNodes = p.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
        const firstVal = valNodes[0]
        const v =
          firstVal !== undefined
            ? await expandNode(firstVal, session, executeFn, callStack)
            : rawVal
        prefixAssignments.push([key, v])
      }
      continue
    }
    if (p.type === NT.COMMAND_NAME) sawCommandName = true
    nonPrefixParts.push(p)
  }

  for (const [k] of prefixAssignments) {
    if (session.readonlyVars.has(k)) {
      const err = new TextEncoder().encode(`bash: ${k}: readonly variable\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: name !== '' ? name : k, exitCode: 1, stderr: err }),
      ]
    }
  }

  if (prefixAssignments.length > 0 && name === '') {
    for (const [k, v] of prefixAssignments) session.env[k] = v
    const cmdLabel = prefixAssignments.map(([k, v]) => `${k}=${v}`).join(' ')
    return [null, new IOResult(), new ExecutionNode({ command: cmdLabel, exitCode: 0 })]
  }

  const isFunctionCall = name !== '' && session.functions[name] !== undefined
  const savedEnvOverrides: Record<string, string | null> = {}
  for (const [k, v] of prefixAssignments) {
    if (!isFunctionCall) savedEnvOverrides[k] = k in session.env ? (session.env[k] ?? null) : null
    session.env[k] = v
  }

  try {
    return await runCommandBody(
      recurse,
      dispatch,
      registry,
      executeFn,
      node,
      nonPrefixParts,
      name,
      session,
      stdinIn,
      callStack,
      jobTable,
      ensureOpen,
      unmount,
      pythonRuntime,
      history,
      signal,
    )
  } finally {
    for (const [k, prev] of Object.entries(savedEnvOverrides)) {
      if (prev === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.env[k]
      } else {
        session.env[k] = prev
      }
    }
  }
}

async function runCommandBody(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  parts: TSNodeLike[],
  name: string,
  session: Session,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  unmount?: (prefix: string) => Promise<void>,
  pythonRuntime?: PyodideRuntime,
  history?: CommandHistory,
  signal?: AbortSignal,
): Promise<Result> {
  let stdin = stdinIn

  for (const child of node.namedChildren) {
    if (child.type === NT.HERESTRING_REDIRECT) {
      for (const sc of child.namedChildren) {
        const content = await expandNode(sc, session, executeFn, callStack)
        stdin = new TextEncoder().encode(`${content}\n`)
        break
      }
    }
  }

  const procSubParts: Uint8Array[] = []
  const cleanParts: TSNodeLike[] = []
  for (const p of parts) {
    if (p.type === NT.PROCESS_SUBSTITUTION) {
      if (getProcessSubDirection(p) === ProcessSubDirection.OUTPUT) {
        const err = new TextEncoder().encode('mirage: unsupported: process substitution >(...)\n')
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({
            command: name === '' ? 'process_sub' : name,
            exitCode: 2,
            stderr: err,
          }),
        ]
      }
      const innerCmds = p.namedChildren.filter((c) => c.type === NT.COMMAND)
      const innerFirst = innerCmds[0]
      if (innerFirst !== undefined) {
        const io = await executeFn(getText(innerFirst), { sessionId: session.sessionId })
        procSubParts.push(await materialize(io.stdout))
      }
      continue
    }
    cleanParts.push(p)
  }
  if (procSubParts.length > 0 && stdin === null) {
    let total = 0
    for (const c of procSubParts) total += c.byteLength
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of procSubParts) {
      merged.set(c, off)
      off += c.byteLength
    }
    stdin = merged
  }

  const expanded = await expandParts(cleanParts, session, executeFn, callStack)

  let textArgs: ReadonlySet<string> | null = null
  let pathArgs: ReadonlySet<string> | null = null
  const cwdMount = registry.mountFor(session.cwd)
  const spec = cwdMount !== null ? cwdMount.specFor(name) : null
  if (spec !== null) {
    const [textSet, pathSet] = classifyArgvBySpec(spec, expanded.slice(1))
    textArgs = textSet.size > 0 ? textSet : null
    pathArgs = pathSet.size > 0 ? pathSet : null
  }

  const classified = classifyParts(expanded, registry, session.cwd, textArgs, pathArgs)
  const resolved = await resolveGlobs(classified, registry, textArgs)
  const finalExpanded = resolved.map((p) => (p instanceof PathSpec ? p.original : p))

  // Unsupported bash builtins. Constructs the parser accepts but the
  // executor cannot honor. Returning a clear error lets LLMs detect a
  // capability gap instead of treating it as a missing binary.
  if (UNSUPPORTED_BUILTINS.has(name)) {
    const err = new TextEncoder().encode(`mirage: unsupported builtin: ${name}\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: name, exitCode: 2, stderr: err }),
    ]
  }

  // Shell builtins
  if (name === SB.PWD) {
    const out = new TextEncoder().encode(`${session.cwd}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'pwd', exitCode: 0 })]
  }

  if (name === SB.CD) {
    let path: string | PathSpec = '/'
    if (classified.length > 1) {
      const raw = classified[1]
      const rawStr = raw instanceof PathSpec ? raw.original : String(raw)
      if (rawStr === '~') path = '/'
      else if (raw instanceof PathSpec) path = raw
      else if (rawStr.startsWith('/')) path = rawStr
      else path = classifyBarePath(rawStr, registry, session.cwd)
    }
    return handleCd(dispatch, (p) => registry.isMountRoot(p), path, session)
  }

  if (name === SB.TRUE) {
    return [null, new IOResult(), new ExecutionNode({ command: 'true', exitCode: 0 })]
  }

  if (name === SB.FALSE) {
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'false', exitCode: 1 }),
    ]
  }

  if (name === SB.EVAL) return handleEval(executeFn, finalExpanded.slice(1), session)
  if (name === SB.BASH || name === SB.SH) {
    return handleBash(executeFn, finalExpanded.slice(1), session, stdin)
  }
  if (name === SB.EXPORT) return handleExport(finalExpanded.slice(1), session)
  if (name === SB.UNSET) return handleUnset(finalExpanded.slice(1), session)
  if (name === SB.LOCAL) return handleLocal(finalExpanded.slice(1), session)
  if (name === SB.PRINTENV) {
    return handlePrintenv(finalExpanded.length > 1 ? (finalExpanded[1] ?? null) : null, session)
  }
  if (name === SB.WHOAMI) return handleWhoami(session)
  if (name === SB.MAN) return handleMan(finalExpanded.slice(1), session, registry)
  if (name === SB.SET) return handleSet(finalExpanded.slice(1), session, callStack)
  if (name === SB.SHIFT) {
    const n = finalExpanded.length > 1 ? Number(finalExpanded[1]) : 1
    return handleShift(Number.isFinite(n) ? n : 1, callStack, session)
  }
  if (name === SB.TRAP) return handleTrap(session)
  if (name === SB.TEST || name === SB.BRACKET || name === SB.DOUBLE_BRACKET) {
    return handleTest(dispatch, classified.slice(1), session)
  }
  if (name === SB.ECHO) {
    const args = finalExpanded.slice(1)
    const nFlag = args.includes('-n')
    const eFlag = args.includes('-e')
    return handleEcho(
      args.filter((a) => a !== '-n' && a !== '-e'),
      nFlag,
      eFlag,
    )
  }
  if (name === SB.PRINTF) return handlePrintf(finalExpanded.slice(1))
  if (name === SB.SLEEP) return handleSleep(finalExpanded.slice(1), signal)
  if (name === SB.READ) {
    return handleRead(finalExpanded.slice(1), session, stdin)
  }
  if (name === SB.SOURCE || name === SB.DOT) {
    const target = classified.length > 1 ? (classified[1] ?? '') : ''
    return handleSource(dispatch, executeFn, target, session)
  }
  if (name === SB.RETURN) {
    const n = finalExpanded.length > 1 ? Number(finalExpanded[1]) : 0
    return handleReturn(Number.isFinite(n) ? n : 0)
  }
  if (name === SB.BREAK) throw new BreakSignal()
  if (name === SB.CONTINUE) throw new ContinueSignal()

  if (name === SB.XARGS) {
    const stdinBytes = await materialize(stdin)
    const inputArgs = new TextDecoder()
      .decode(stdinBytes)
      .split(/\s+/)
      .filter((s) => s !== '')
    const xargsCmd = finalExpanded[1] ?? 'echo'
    const inner = `${xargsCmd} ${inputArgs.join(' ')}`
    const io = await executeFn(inner, { sessionId: session.sessionId })
    return [io.stdout, io, new ExecutionNode({ command: 'xargs', exitCode: io.exitCode })]
  }

  if (name === SB.TIMEOUT) {
    if (finalExpanded.length >= 3) {
      const innerCmd = finalExpanded.slice(2).join(' ')
      const io = await executeFn(innerCmd, { sessionId: session.sessionId })
      return [io.stdout, io, new ExecutionNode({ command: 'timeout', exitCode: io.exitCode })]
    }
    return [null, new IOResult(), new ExecutionNode({ command: 'timeout', exitCode: 0 })]
  }

  // Default: mount-dispatched command
  return handleCommand(
    recurse,
    dispatch,
    registry,
    classified,
    session,
    stdin,
    callStack,
    jobTable,
    ensureOpen,
    unmount,
    history,
    pythonRuntime,
  )
}

export function classifyArgvBySpec(
  spec: CommandSpec,
  argv: readonly string[],
): [Set<string>, Set<string>] {
  const boolFlags = new Set<string>()
  const valueFlags = new Set<string>()
  const valueFlagKinds = new Map<string, OperandKind>()
  const longBoolFlags = new Set<string>()
  const longValueFlags = new Set<string>()
  let numericShorthandFlag: string | null = null
  for (const opt of spec.options) {
    if (opt.short !== null) {
      if (opt.valueKind === OperandKind.NONE) boolFlags.add(opt.short)
      else {
        valueFlags.add(opt.short)
        valueFlagKinds.set(opt.short, opt.valueKind)
        if (opt.numericShorthand) numericShorthandFlag = opt.short
      }
    }
    if (opt.long !== null) {
      if (opt.valueKind === OperandKind.NONE) longBoolFlags.add(opt.long)
      else {
        longValueFlags.add(opt.long)
        valueFlagKinds.set(opt.long, opt.valueKind)
      }
    }
  }
  const positional = spec.positional.map((op) => op.kind)
  const restKind = spec.rest?.kind ?? null

  const rawArgs: string[] = []
  const flagTextValues = new Set<string>()
  let i = 0
  let endOfFlags = false
  while (i < argv.length) {
    const tok = argv[i]
    if (tok === undefined) break
    if (tok === '--' && !endOfFlags) {
      endOfFlags = true
      i += 1
      continue
    }
    if (endOfFlags) {
      rawArgs.push(tok)
      i += 1
      continue
    }
    if (spec.ignoreTokens.has(tok)) {
      i += 1
      continue
    }
    if (tok.startsWith('--')) {
      if (longValueFlags.has(tok) && i + 1 < argv.length) {
        if (valueFlagKinds.get(tok) === OperandKind.TEXT) {
          flagTextValues.add(argv[i + 1] ?? '')
        }
        i += 2
      } else {
        if (!longBoolFlags.has(tok)) rawArgs.push(tok)
        i += 1
      }
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      if (numericShorthandFlag !== null && /^-\d+$/.test(tok)) {
        flagTextValues.add(tok.slice(1))
        i += 1
        continue
      }
      let matched = false
      for (const vf of valueFlags) {
        if (tok === vf && i + 1 < argv.length) {
          if (valueFlagKinds.get(vf) === OperandKind.TEXT) {
            flagTextValues.add(argv[i + 1] ?? '')
          }
          i += 2
          matched = true
          break
        }
        if (tok.startsWith(vf) && tok.length > vf.length) {
          if (valueFlagKinds.get(vf) === OperandKind.TEXT) {
            flagTextValues.add(tok.slice(vf.length))
          }
          i += 1
          matched = true
          break
        }
      }
      if (matched) continue
      if (boolFlags.has(tok)) {
        i += 1
        continue
      }
      let allBool = true
      for (const ch of tok.slice(1)) {
        if (!boolFlags.has(`-${ch}`)) {
          allBool = false
          break
        }
      }
      if (allBool && tok.length > 1) {
        i += 1
        continue
      }
      rawArgs.push(tok)
      i += 1
      continue
    }
    rawArgs.push(tok)
    i += 1
  }

  const textSet = new Set<string>()
  const pathSet = new Set<string>()
  for (let j = 0; j < rawArgs.length; j++) {
    const arg = rawArgs[j]
    if (arg === undefined) continue
    let kind: OperandKind | null
    if (j < positional.length) kind = positional[j] ?? null
    else kind = restKind
    if (kind === null) continue
    if (kind === OperandKind.TEXT) textSet.add(arg)
    else if (kind === OperandKind.PATH) pathSet.add(arg)
  }
  for (const v of flagTextValues) textSet.add(v)
  return [textSet, pathSet]
}
