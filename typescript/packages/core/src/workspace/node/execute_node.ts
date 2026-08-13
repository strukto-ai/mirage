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

import type { Runtime } from '../../runtime/base.ts'
import type { PolicyDecision } from '../../runtime/policy/index.ts'
import { asyncChain } from '../../io/stream.ts'
import { type ByteSource, IOResult } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import { makeAbortError } from '../abort.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { assignmentStatus, finishStatement } from '../executor/statement.ts'
import {
  getCaseItems,
  getCaseWord,
  getDeclarationKeyword,
  getCforParts,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getPipelineCommands,
  getRedirects,
  getText,
  getUnsetArgs,
  getWhileParts,
} from '../../shell/helpers.ts'
import { JobTable } from '../../shell/job_table.ts'
import { ERREXIT_EXEMPT_TYPES, NodeType as NT, Redirect, RedirectKind } from '../../shell/types.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import { expandRedirects } from '../expand/redirects.ts'
import { type ExecuteFn, expandArith, expandNode } from '../expand/node.ts'
import { expandPattern } from '../expand/pattern.ts'
import { evaluateArith } from '../../shell/arith.ts'
import {
  type ShellArray,
  arrayAppend,
  arrayExtent,
  arrayGet,
  arraySet,
  makeArray,
} from '../../shell/array.ts'
import { ArithError, ExitSignal, ReadonlyError } from '../../shell/errors.ts'
import { expandAndClassify } from '../expand/parts.ts'
import { arrayIndex } from '../expand/variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { wordText } from '../../types.ts'
import {
  type CforEval,
  handleCase,
  handleCfor,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from '../executor/control.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import {
  handleExport,
  handleLocal,
  handleReadonly,
  handleTest,
  handleUnset,
  noteLocalArray,
} from '../executor/builtins/index.ts'
import { handleConnection, handlePipe, handleSubshell } from '../executor/pipes.ts'
import { handleRedirect } from '../executor/redirect.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import { resolveGlobs } from '../expand/globs.ts'
import { expandDoubleBracket, expandTestExpr } from './test_expr.ts'
import { executeProgram } from './program.ts'
import { executeCommand } from './command_dispatch.ts'
import { traceAssignment } from '../../shell/xtrace.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]
type Recurse = (
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
) => Promise<Result>

// Array-literal elements behave like any other shell word list: command
// substitutions word-split and globs resolve to matches
// (`a=($(cmd) /data/*.txt)`), with zero-match globs kept literal.
/**
 * Evaluate one C-style for expression slot: the slot's integer value,
 * or the default for an empty slot (1 for the condition so `for
 * ((;;))` loops, 0 for init/update). Re-raises ArithError with the
 * expression text prepended so the loop can print bash's
 * `((: expr: reason` diagnostic, and throws ReadonlyError when the
 * expression assigns to a readonly variable.
 */
async function evalCforExpr(
  expr: TSNodeLike | null,
  dflt: number,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<number> {
  if (expr === null) return dflt
  const text = await expandArith(expr, session, executeFn, callStack)
  let value: bigint
  let updates: Record<string, string>
  try {
    ;({ value, updates } = evaluateArith(text, session.env))
  } catch (err) {
    if (!(err instanceof ArithError)) throw err
    throw new ArithError(`${text}: ${err.message}`)
  }
  for (const name of Object.keys(updates)) {
    if (session.readonlyVars.has(name)) throw new ReadonlyError(name)
  }
  Object.assign(session.env, updates)
  return Number(value)
}

async function expandArrayItems(
  arrayNode: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  callStack: CallStack | null,
): Promise<string[]> {
  const classified = await expandAndClassify(
    arrayNode.namedChildren,
    session,
    executeFn,
    registry,
    session.cwd,
    callStack,
  )
  const resolved = await resolveGlobs(classified, registry, session.shellOptions.noglob === true)
  return resolved.map((w) => wordText(w))
}

async function recurseReassociated(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  redirects: readonly Redirect[],
  right: TSNodeLike,
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (node !== right) return recurse(node, session, stdin, callStack)
  const [expanded, pipeNode] = await expandRedirects(
    redirects,
    session,
    executeFn,
    registry,
    callStack,
  )
  let [stdout, io, execNode] = await handleRedirect(
    recurse,
    dispatch,
    right,
    expanded,
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

async function recursePipeStderr(
  recurse: Recurse,
  dispatch: DispatchFn,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  targets: readonly TSNodeLike[],
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<Result> {
  if (!targets.includes(node) || nodeKind(node) !== NodeKind.REDIRECT) {
    return recurse(node, session, stdin, callStack)
  }
  const [command, redirects] = getRedirects(node)
  redirects.push(new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }))
  const [expanded, pipeNode] = await expandRedirects(
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
    expanded,
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
  runtimeBindings?: Record<string, Runtime>
  routingDecision?: PolicyDecision
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

  if (deps.signal?.aborted === true || session.abortSignal?.aborted === true) {
    throw makeAbortError()
  }
  session.errexitImmune = false

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
      deps.runtimeBindings,
      deps.routingDecision,
      deps.signal,
    )
  }

  if (kind === NodeKind.PIPELINE) {
    const [pipeCommands, stderrFlags] = getPipelineCommands(node)
    let commands = pipeCommands
    // `! a | b` parses as pipeline(negated_command(a), b) but bash
    // negates the WHOLE pipeline's exit status.
    const first = commands[0]
    const negated = first?.type === NT.NEGATED_COMMAND
    if (negated) {
      commands = [getNegatedCommand(first), ...commands.slice(1)]
    }
    let pipeRecurse = recurse
    if (stderrFlags.some(Boolean)) {
      const targets = commands.filter((_, i) => stderrFlags[i] === true)
      pipeRecurse = recursePipeStderr.bind(null, recurse, dispatch, executeFn, registry, targets)
    }
    const [stdout, io, execNode] = await handlePipe(
      pipeRecurse,
      commands,
      stderrFlags,
      session,
      stdin,
      callStack,
    )
    if (!negated) return [stdout, io, execNode]
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    session.errexitImmune = true
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.LIST) {
    const [left, op, right] = getListParts(node)
    return handleConnection(recurse, left, op, right, session, stdin, callStack)
  }

  if (kind === NodeKind.REDIRECT) {
    const [command, redirects] = getRedirects(node)
    if (command !== null && command.type === NT.LIST) {
      // tree-sitter hoists a trailing redirect over the whole &&/||
      // list; bash binds it to the last command:
      //   redirected(list(L, op, R), r) == list(L, op, redirected(R, r))
      // Re-associate and defer target expansion until R runs, so
      // `cd /x && echo hi > f` writes under /x. Compound and subshell
      // bodies keep the whole-body redirect (bash group semantics).
      const [left, op, right] = getListParts(command)
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handleConnection(wrapped, left, op, right, session, stdin, callStack)
    }
    if (command !== null && command.type === NT.PIPELINE) {
      const [commands, stderrFlags] = getPipelineCommands(command)
      const right = commands[commands.length - 1]
      if (right === undefined) throw new Error('redirected pipeline: missing command')
      const wrapped = recurseReassociated.bind(
        null,
        recurse,
        dispatch,
        executeFn,
        registry,
        redirects,
        right,
      )
      return handlePipe(wrapped, commands, stderrFlags, session, stdin, callStack)
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
    // A subshell is its own shell: background jobs started inside live
    // in a private job table (`$!`/`wait`/`kill` in the body see them;
    // the parent's table never does), mirroring bash's forked process.
    const subTable = new JobTable()
    const subDeps: ExecuteNodeDeps = { ...deps, jobTable: subTable }
    const subRecurse = (
      n: TSNodeLike,
      s: Session,
      inp: ByteSource | null,
      cs: CallStack | null,
    ): Promise<Result> => executeNode(subDeps, n, s, inp, cs)
    return handleSubshell(subRecurse, node.children, session, stdin, callStack, subTable, agentId)
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
      const [rawStdout, io, execNode] = await recurse(child, session, stdin, callStack)
      lastExec = execNode
      const stdout = await finishStatement(rawStdout, io, session)
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(child.type) &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- recurse() mutates it
        !session.errexitImmune
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

  if (kind === NodeKind.CFOR) {
    const [exprs, body] = getCforParts(node)
    const evalExpr: CforEval = (e, d) => evalCforExpr(e, d, session, executeFn, callStack)
    return handleCfor(recurse, exprs, body, evalExpr, session, stdin, callStack)
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
    const resolved = await resolveGlobs(classified, registry, session.shellOptions.noglob === true)
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
    const items: [string[], TSNodeLike[], string][] = []
    for (const [patternNodes, body, terminator] of getCaseItems(node)) {
      const patterns: string[] = []
      for (const patternNode of patternNodes) {
        patterns.push(await expandPattern(patternNode, session, executeFn, callStack))
      }
      items.push([patterns, body, terminator])
    }
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
    // Array literals are staged, not stored: `readonly -a a=(y)` on an
    // already-readonly name has to fail with the old value intact.
    const staged: { name: string; append: boolean; items: string[] }[] = []
    // Option words are kept verbatim, in order, so `--` survives as an
    // end-of-options marker and the handlers can name the *first* bad option
    // letter the way bash does.
    const flagWords: string[] = []
    const flagChars = new Set<string>()
    let optsDone = false
    for (const child of node.namedChildren) {
      if (child.type === NT.VARIABLE_ASSIGNMENT) {
        const valNodes = child.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
        const firstVal = valNodes[0]
        if (firstVal?.type === NT.ARRAY) {
          const text = getText(child)
          const eq = text.indexOf('=')
          const key = eq >= 0 ? text.slice(0, eq) : text
          const append = key.endsWith('+')
          staged.push({
            name: append ? key.slice(0, -1) : key,
            append,
            items: await expandArrayItems(firstVal, session, executeFn, registry, callStack),
          })
          continue
        }
        assignments.push(await expandNode(child, session, executeFn, callStack))
      } else if (
        child.type === NT.SIMPLE_EXPANSION ||
        child.type === NT.EXPANSION ||
        child.type === NT.CONCATENATION ||
        child.type === NT.WORD ||
        // A bare `readonly NAME` / `export NAME` operand parses as a
        // variable_name, not a word, and a quoted assignment
        // (`export 'FOO=bar'`) as a plain string operand.
        child.type === NT.VARIABLE_NAME ||
        child.type === NT.STRING ||
        child.type === NT.RAW_STRING ||
        child.type === NT.ANSI_C_STRING ||
        child.type === NT.TRANSLATED_STRING
      ) {
        const expanded = await expandNode(child, session, executeFn, callStack)
        if (expanded === '') continue
        if (!optsDone && expanded.startsWith('-') && expanded.length > 1) {
          flagWords.push(expanded)
          if (expanded === '--') optsDone = true
          else for (const ch of expanded.slice(1)) flagChars.add(ch)
        } else {
          assignments.push(expanded)
        }
      }
    }
    const arrayNames = staged.map((entry) => entry.name)
    const isReadonly = keyword === 'readonly' || flagChars.has('r')
    for (const name of arrayNames) {
      if (isReadonly && session.readonlyVars.has(name)) {
        const err = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: keyword, exitCode: 1, stderr: err }),
        ]
      }
    }
    for (const { name, append, items } of staged) {
      noteLocalArray(session, name)
      let base: ShellArray
      if (append) {
        const existing = session.arrays[name]
        if (existing === undefined) {
          const scalar = session.env[name]
          base = scalar === undefined ? [] : [scalar]
        } else {
          base = existing
        }
        arrayAppend(base, items)
      } else {
        base = makeArray(items)
      }
      session.arrays[name] = base
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.env[name]
    }
    if (flagChars.has('a')) {
      // `declare -a NAME` with no value declares an empty array, so
      // ${#NAME[@]} is 0 and NAME[3]=x leaves index 0 unassigned.
      for (const bare of assignments) {
        if (bare.includes('=')) continue
        if (noteLocalArray(session, bare)) {
          // Inside a function this shadows whatever the caller had with a
          // fresh empty array.
          session.arrays[bare] = []
        } else if (!Object.hasOwn(session.arrays, bare)) {
          // At top level an existing scalar becomes element 0.
          const scalar = session.env[bare]
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete session.env[bare]
          session.arrays[bare] = scalar === undefined ? [] : [scalar]
        }
      }
    }
    if (isReadonly) {
      // An array assignment stores itself above, but the name still has
      // to be marked readonly. Only the `readonly` keyword owns -p /
      // illegal-option handling; `declare -r` keeps names only.
      if (keyword === 'readonly') {
        return handleReadonly([...flagWords, ...assignments, ...arrayNames], session)
      }
      return handleReadonly([...assignments, ...arrayNames], session)
    }
    // declare/typeset scope like `local` inside a function (bash
    // semantics) and assign globally at top level, which is exactly
    // handleLocal's fallback when no function scope is active.
    if (keyword === NT.LOCAL || keyword === 'declare' || keyword === 'typeset') {
      return handleLocal(assignments, session)
    }
    // Pass export flags through so -p / bare print and illegal options work.
    return handleExport([...flagWords, ...assignments], session)
  }

  if (kind === NodeKind.UNSET) {
    return handleUnset(getUnsetArgs(node), session)
  }

  if (kind === NodeKind.TEST) {
    const opener = node.children[0]?.type ?? '['
    if (opener === '[[') {
      const tree = await expandDoubleBracket(node, session, executeFn, callStack)
      return handleTest(dispatch, deps.namespace, tree, session, '[[')
    }
    const expanded = await expandTestExpr(node, session, executeFn, callStack)
    return handleTest(dispatch, deps.namespace, expanded, session, '[')
  }

  if (kind === NodeKind.NEGATED) {
    const inner = getNegatedCommand(node)
    const [rawStdout, io, execNode] = await recurse(inner, session, stdin, callStack)
    // Lazy exit codes (exitOnEmpty in grep) must be final before
    // inverting, or `! grep miss f` negates the provisional 0.
    const stdout = await applyBarrier(rawStdout, io, BarrierPolicy.VALUE)
    const flipped = new IOResult({
      exitCode: io.exitCode !== 0 ? 0 : 1,
      stderr: io.stderr,
      reads: io.reads,
      writes: io.writes,
      cache: io.cache,
    })
    execNode.exitCode = flipped.exitCode
    session.errexitImmune = true
    return [stdout, flipped, execNode]
  }

  if (kind === NodeKind.VAR_ASSIGN) {
    const text = getText(node)
    if (!text.includes('=')) {
      return [null, new IOResult(), new ExecutionNode({ command: text, exitCode: 0 })]
    }
    const subSeq = session.cmdsubSeq
    const subscriptNode = node.namedChildren.find((c) => c.type === 'subscript') ?? null
    const nameSource = subscriptNode ?? node
    const nameNode = nameSource.namedChildren.find((c) => c.type === NT.VARIABLE_NAME)
    const eq = text.indexOf('=')
    const key = nameNode !== undefined ? nameNode.text : text.slice(0, eq)
    const append = node.children.some((c) => c.type === '+=')
    if (session.readonlyVars.has(key)) {
      // A bare assignment to a readonly variable is a fatal
      // variable-assignment error in non-interactive bash: the rest of
      // the line is abandoned (builtins like `export` merely fail with
      // 1 and continue).
      const err = new TextEncoder().encode(`bash: ${key}: readonly variable\n`)
      throw new ExitSignal(1, err, null, 1)
    }
    const valNodes = node.namedChildren.filter(
      (c) => c.type !== NT.VARIABLE_NAME && c.type !== 'subscript',
    )
    const firstVal = valNodes[0]
    if (firstVal?.type === NT.ARRAY) {
      const items = await expandArrayItems(firstVal, session, executeFn, registry, callStack)
      if (append) {
        let base = session.arrays[key]
        if (base === undefined) {
          const scalar = session.env[key]
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete session.env[key]
          base = scalar === undefined ? [] : [scalar]
        }
        // `arr+=(...)` starts at the extent, so it fills the hole a
        // trailing `unset arr[last]` left but skips interior ones.
        arrayAppend(base, items)
        session.arrays[key] = base
      } else {
        session.arrays[key] = makeArray(items)
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.env[key]
      }
      const arrCode = assignmentStatus(session, subSeq)
      return [
        null,
        new IOResult({ exitCode: arrCode }),
        new ExecutionNode({ command: text, exitCode: arrCode }),
      ]
    }
    let val = text.slice(eq + 1)
    if (firstVal !== undefined) {
      val = await expandNode(firstVal, session, executeFn, callStack)
    }
    if (subscriptNode !== null) {
      let idxText = ''
      for (const sc of subscriptNode.namedChildren) {
        if (sc.type !== NT.VARIABLE_NAME) {
          idxText = sc.text
          break
        }
      }
      let arr = session.arrays[key]
      if (arr === undefined) {
        const scalar = session.env[key]
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.env[key]
        arr = scalar === undefined ? [] : [scalar]
      }
      let idx = arrayIndex(idxText, session.env)
      if (idx < 0) idx += arrayExtent(arr)
      if (idx < 0) {
        // bash aborts the whole line on a bad assignment subscript
        // (status 1); containment mirrors ${var:?}.
        const nameText = text.slice(0, eq).replace(/\+$/, '')
        throw new ExitSignal(
          1,
          new TextEncoder().encode(`bash: ${nameText}: bad array subscript\n`),
          null,
          1,
        )
      }
      arraySet(arr, idx, append ? arrayGet(arr, idx) + val : val)
      session.arrays[key] = arr
      const subCode = assignmentStatus(session, subSeq)
      return [
        null,
        new IOResult({ exitCode: subCode }),
        new ExecutionNode({ command: text, exitCode: subCode }),
      ]
    }
    if (append) {
      const arr = session.arrays[key]
      if (arr !== undefined) {
        arraySet(arr, 0, arrayGet(arr, 0) + val)
      } else {
        session.env[key] = (session.env[key] ?? '') + val
      }
    } else {
      session.env[key] = val
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.arrays[key]
    }
    // Reassigning OPTIND (even to its current value) restarts the getopts
    // scan, matching bash's internal char pointer.
    if (key === 'OPTIND') session.getoptsOptind = null
    const code = assignmentStatus(session, subSeq)
    const assignIo = new IOResult({ exitCode: code })
    if (session.shellOptions.xtrace === true) {
      assignIo.stderr = traceAssignment(key, val, append)
    }
    return [null, assignIo, new ExecutionNode({ command: text, exitCode: code })]
  }

  // Assignment-only statement (a=1 b=2).
  if (kind === NodeKind.VAR_ASSIGNS) {
    const subSeq = session.cmdsubSeq
    let mergedIo = new IOResult()
    for (const child of node.namedChildren) {
      if (child.type !== NT.VARIABLE_ASSIGNMENT) continue
      const [, io] = await recurse(child, session, stdin, callStack)
      mergedIo = await mergedIo.merge(io)
    }
    // The statement's status follows the last command substitution
    // performed across ALL its assignments, not the last child's.
    const code = assignmentStatus(session, subSeq)
    mergedIo.exitCode = code
    return [null, mergedIo, new ExecutionNode({ command: getText(node), exitCode: code })]
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
