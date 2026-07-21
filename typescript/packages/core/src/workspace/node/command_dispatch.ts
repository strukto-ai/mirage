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
import type { RoutingDecision } from '../executor/route/index.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import type { Resource } from '../../resource/base.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  ProcessSubDirection,
  getCommandName,
  getParts,
  getProcessSubBody,
  getProcessSubDirection,
  getText,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { NodeType as NT, ShellBuiltin as SB } from '../../shell/types.ts'
import { PathSpec, wordText } from '../../types.ts'
import { classifyBarePath } from '../expand/classify/index.ts'
import type { Argv } from '../expand/argv.ts'
import { expandArgv } from '../expand/argv.ts'
import { type ExecuteFn, expandNode } from '../expand/node.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { handleCommand } from '../executor/command.ts'
import { runWithTimeout } from '../../commands/builtin/utils/safeguard.ts'
import { resolveSafeguard } from '../../commands/safeguard.ts'
import { BreakSignal, ContinueSignal } from '../executor/control.ts'
import { traceCommand } from '../../shell/xtrace.ts'
import type { DispatchFn } from '../executor/cross_mount.ts'
import {
  followPaths,
  handleBash,
  handleCd,
  handleCommandBuiltin,
  handleType,
  handleEcho,
  handleEval,
  handleExport,
  handleHistory,
  handleChmod,
  handleChown,
  handleLn,
  handleLocal,
  handleMan,
  handlePrintenv,
  handlePrintf,
  handleRead,
  handleReadlink,
  handleTouch,
  handleExit,
  handleReturn,
  handleSet,
  handleShift,
  handleSleep,
  handleSource,
  handleTest,
  handleTimeout,
  handleTrap,
  handleUnset,
  handleWhoami,
  handleXargs,
  linkFlags,
  prepareMv,
  stripLinkOperands,
} from '../executor/builtins/index.ts'
import { CycleError } from '../../utils/path.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { NO_FOLLOW_COMMANDS, UNSUPPORTED_BUILTINS } from '../route/index.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { ExecutionNode } from '../types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

// Parse the optional numeric level of `break`/`continue`.
function loopLevels(args: readonly string[]): number {
  const first = args[0]
  if (first !== undefined && /^\d+$/.test(first) && parseInt(first, 10) > 0) {
    return parseInt(first, 10)
  }
  return 1
}

// Split leading `cd` option flags (-L -P -e -@, clusters like -LP, and a
// `--` terminator) from the directory operand. A bare `-` is the OLDPWD
// operand, not an option. `bad` is the first unknown option character.
function splitCdOptions(args: (string | PathSpec)[]): {
  operands: (string | PathSpec)[]
  bad: string | null
  physical: boolean
} {
  const operands: (string | PathSpec)[] = []
  let parsing = true
  let physical = false
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.virtual : arg
    if (parsing) {
      if (s === '--') {
        parsing = false
        continue
      }
      if (s !== '-' && s.length >= 2 && s.startsWith('-')) {
        let bad: string | null = null
        for (const c of s.slice(1)) {
          if (!'LPe@'.includes(c)) {
            bad = c
            break
          }
        }
        if (bad !== null) return { operands, bad, physical }
        for (const c of s.slice(1)) {
          if (c === 'P') physical = true
          else if (c === 'L') physical = false
        }
        continue
      }
      parsing = false
    }
    operands.push(arg)
  }
  return { operands, bad: null, physical }
}

export async function executeCommand(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  session: Session,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  unmount?: (prefix: string) => Promise<void>,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: RoutingDecision,
  signal?: AbortSignal,
): Promise<Result> {
  const name = getCommandName(node)
  const [assignmentNodes, nonPrefixParts] = splitEnvPrefix(getParts(node))

  const prefixAssignments: [string, string][] = []
  for (const p of assignmentNodes) {
    const atext = getText(p)
    const eq = atext.indexOf('=')
    if (eq < 0) continue
    const key = atext.slice(0, eq)
    const rawVal = atext.slice(eq + 1)
    const valNodes = p.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
    const firstVal = valNodes[0]
    const v =
      firstVal !== undefined ? await expandNode(firstVal, session, executeFn, callStack) : rawVal
    prefixAssignments.push([key, v])
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
      namespace,
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
      runtimeBindings,
      routingDecision,
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
  namespace: Namespace,
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
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: RoutingDecision,
  signal?: AbortSignal,
): Promise<Result> {
  let stdin = stdinIn

  if (node.parent?.type !== NT.REDIRECTED_STATEMENT) {
    for (const child of node.namedChildren) {
      if (child.type === NT.HERESTRING_REDIRECT) {
        for (const sc of child.namedChildren) {
          const content = await expandNode(sc, session, executeFn, callStack)
          stdin = new TextEncoder().encode(`${content}\n`)
          break
        }
      }
    }
  }

  const procSubParts: Uint8Array[] = []
  const procSubStderr: Uint8Array[] = []
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
      const inner = getProcessSubBody(p)
      if (inner !== '') {
        const io = await executeFn(inner, { sessionId: session.sessionId })
        procSubParts.push(await materialize(io.stdout))
        const stderr = await materialize(io.stderr)
        if (stderr.byteLength > 0) procSubStderr.push(stderr)
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

  const argv = await expandArgv(cleanParts, session, executeFn, callStack, registry)

  // Safeguards resolve against the expanded name, so `$CMD`-style
  // invocations get their real command's policy.
  const resolved = argv.name !== '' ? resolveSafeguard(argv.name) : null
  const timeout = resolved !== null ? resolved.timeoutSeconds : null
  // Capture xtrace before the body runs so `set -x` itself is not
  // traced (bash enables tracing only for the following commands).
  const xtrace = session.shellOptions.xtrace === true
  const [stdout, io, execNode] = await runWithTimeout(
    runArgv(
      recurse,
      dispatch,
      registry,
      namespace,
      executeFn,
      argv,
      session,
      stdin,
      callStack,
      jobTable,
      ensureOpen,
      unmount,
      runtimeBindings,
      routingDecision,
      signal,
    ),
    timeout,
    argv.name !== '' ? argv.name : '?',
  )
  if (procSubStderr.length > 0) {
    const stderr = await materialize(io.stderr)
    io.stderr = concatBytes([...procSubStderr, stderr])
    execNode.stderr = io.stderr
  }
  if (xtrace && argv.name !== '') {
    const existing = await materialize(io.stderr)
    io.stderr = concatBytes([traceCommand([argv.name, ...argv.args]), existing])
  }
  return [stdout, io, execNode]
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function runArgv(
  recurse: (
    n: TSNodeLike,
    s: Session,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  argv: Argv,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  ensureOpen?: (resource: Resource) => Promise<void>,
  unmount?: (prefix: string) => Promise<void>,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: RoutingDecision,
  signal?: AbortSignal,
): Promise<Result> {
  const name = argv.name
  const args = [...argv.args]
  let operands = [...argv.operands]

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
    const { operands: cdOperands, bad, physical } = splitCdOptions(operands)
    const links = namespace.symlinkTargets()
    if (bad !== null) {
      const err = new TextEncoder().encode(
        `cd: -${bad}: invalid option\ncd: usage: cd [-L|[-P [-e]] [-@]] [dir]\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'cd', exitCode: 2, stderr: err }),
      ]
    }
    if (cdOperands.length > 1) {
      const err = new TextEncoder().encode('cd: too many arguments\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'cd', exitCode: 1, stderr: err }),
      ]
    }
    if (cdOperands.length === 0) {
      const home = homeDir(session)
      if (home === null) {
        const err = new TextEncoder().encode('cd: HOME not set\n')
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'cd', exitCode: 1, stderr: err }),
        ]
      }
      return handleCd(
        dispatch,
        (p) => registry.isMountRoot(p),
        home,
        session,
        false,
        null,
        links,
        physical,
      )
    }
    const raw = cdOperands[0]
    const rawStr = raw instanceof PathSpec ? raw.virtual : String(raw)
    if (rawStr === '-') {
      const old = session.env.OLDPWD
      if (!old) {
        const err = new TextEncoder().encode('cd: OLDPWD not set\n')
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: 'cd -', exitCode: 1, stderr: err }),
        ]
      }
      return handleCd(
        dispatch,
        (p) => registry.isMountRoot(p),
        old,
        session,
        true,
        null,
        links,
        physical,
      )
    }
    let path: string | PathSpec
    let cdpathTarget: string
    if (raw instanceof PathSpec) {
      path = raw
      cdpathTarget = raw.rawPath
    } else if (rawStr.startsWith('/')) {
      path = rawStr
      cdpathTarget = rawStr
    } else {
      path = classifyBarePath(rawStr, registry, session.cwd)
      cdpathTarget = rawStr
    }
    return handleCd(
      dispatch,
      (p) => registry.isMountRoot(p),
      path,
      session,
      false,
      cdpathTarget,
      links,
      physical,
    )
  }

  if (name === SB.TRUE) {
    return [null, new IOResult(), new ExecutionNode({ command: 'true', exitCode: 0 })]
  }

  if (name === SB.COLON) {
    return [null, new IOResult(), new ExecutionNode({ command: ':', exitCode: 0 })]
  }

  if (name === SB.FALSE) {
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'false', exitCode: 1 }),
    ]
  }

  if (name === SB.EVAL) return handleEval(executeFn, args, session)
  if (name === SB.BASH || name === SB.SH) {
    return handleBash(executeFn, args, session, stdin)
  }
  if (name === SB.EXPORT) return handleExport(args, session)
  if (name === SB.UNSET) return handleUnset(args, session)
  if (name === SB.LOCAL) return handleLocal(args, session)
  if (name === SB.PRINTENV) {
    return handlePrintenv(args.length > 0 ? (args[0] ?? null) : null, session)
  }
  if (name === SB.WHOAMI) return handleWhoami(namespace)
  if (name === SB.MAN) return handleMan(args, session, registry)
  if (name === SB.HISTORY) return handleHistory(registry, args, session)
  if (name === SB.SET) return handleSet(args, session, callStack)
  if (name === SB.SHIFT) {
    return handleShift(args, callStack, session)
  }
  if (name === SB.TRAP) return handleTrap(session)
  if (name === SB.TEST || name === SB.BRACKET || name === SB.DOUBLE_BRACKET) {
    let testArgs = [...operands]
    const testName = name === SB.BRACKET ? '[' : 'test'
    if (name === SB.BRACKET) {
      const last = testArgs[testArgs.length - 1]
      if (last !== undefined && wordText(last) === ']') {
        testArgs = testArgs.slice(0, -1)
      } else {
        const err = new TextEncoder().encode("[: missing `]'\n")
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: '[', exitCode: 2, stderr: err }),
        ]
      }
    }
    return handleTest(dispatch, namespace, testArgs, session, testName)
  }
  if (name === SB.ECHO) {
    return handleEcho(args)
  }
  if (name === SB.PRINTF) return handlePrintf(args)
  if (name === SB.SLEEP) return handleSleep(args, signal)
  if (name === SB.READ) {
    return handleRead(args, session, stdin)
  }
  if (name === SB.SOURCE || name === SB.DOT) {
    const target = operands[0] ?? ''
    return handleSource(dispatch, executeFn, target, session)
  }
  if (name === SB.RETURN) {
    return handleReturn(args, session, callStack)
  }
  if (name === SB.EXIT) {
    return handleExit(args, session)
  }
  if (name === SB.BREAK) throw new BreakSignal(null, new IOResult(), loopLevels(args))
  if (name === SB.CONTINUE) throw new ContinueSignal(null, new IOResult(), loopLevels(args))

  if (name === SB.COMMAND) {
    return handleCommandBuiltin(executeFn, args, session, registry, stdin)
  }

  if (name === SB.TYPE) {
    return handleType(args, session, registry)
  }

  if (name === SB.XARGS) {
    return handleXargs(executeFn, args, session, stdin)
  }

  if (name === SB.TIMEOUT) {
    return handleTimeout(executeFn, args, session)
  }

  // Symlinks are namespace-backed: not bash builtins, not mount commands.
  // They mutate the addressing layer. `readlink -f/-e/-m` is canonicalization,
  // which falls through to the mount command.
  if (name === 'ln' && linkFlags(operands, 'sfnv').has('s')) {
    return await handleLn(namespace, session, operands)
  }
  if (name === 'readlink') {
    return handleReadlink(namespace, session, operands)
  }

  // Metadata commands (namespace-routed: resolve-then-setattr with
  // overlay fallback; they run their own link follow).
  if (name === 'chmod') {
    return handleChmod(namespace, dispatch, operands)
  }
  if (name === 'chown') {
    return handleChown(namespace, dispatch, operands)
  }
  if (name === 'touch') {
    return handleTouch(namespace, dispatch, session, operands)
  }

  // Symlink-aware dispatch: reads follow links (open(2)); rm/mv act on
  // the link entry itself (lstat semantics).
  let postUnlink: string | null = null
  let postRename: [string, string] | null = null
  let dispatchArgv = argv
  if (namespace.nodes.size > 0) {
    try {
      if (name === 'rm') {
        const [rest, removed] = await stripLinkOperands(namespace, operands)
        operands = rest
        if (removed > 0 && !rest.some((a) => a instanceof PathSpec)) {
          return [null, new IOResult(), new ExecutionNode({ command: name, exitCode: 0 })]
        }
      } else if (name === 'mv') {
        const prepared = await prepareMv(namespace, dispatch, operands)
        operands = prepared.items
        postUnlink = prepared.postUnlink
        postRename = prepared.postRename
        if (prepared.early !== null) return prepared.early
      } else if (!NO_FOLLOW_COMMANDS.has(name)) {
        operands = followPaths(namespace, operands)
      }
    } catch (err) {
      if (err instanceof CycleError) {
        const errBytes = new TextEncoder().encode(
          `${name}: ${err.path}: Too many levels of symbolic links\n`,
        )
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: name, exitCode: 1, stderr: errBytes }),
        ]
      }
      throw err
    }
    dispatchArgv = argv.withOperands(operands)
  }

  // Default: mount-dispatched command
  const [stdout, io, execNode] = await handleCommand(
    recurse,
    dispatch,
    registry,
    dispatchArgv.words,
    session,
    stdin,
    callStack,
    jobTable,
    ensureOpen,
    unmount,
    runtimeBindings,
    namespace,
    routingDecision,
  )

  if (io.exitCode === 0 && namespace.nodes.size > 0) {
    if (name === 'rm') {
      // A removed path takes its node meta (overlay attrs) with it; a
      // removed dir purges everything underneath. Glob operands reach
      // here unexpanded (backend wrappers expand them), so the node
      // table matches the pattern itself.
      for (const item of operands) {
        if (!(item instanceof PathSpec)) continue
        if (item.pattern !== null) {
          await namespace.unlinkGlob(item.virtual)
        } else {
          await namespace.unlink(item.virtual)
          await namespace.purgeUnder(item.virtual)
        }
      }
    }
    if (postUnlink !== null) await namespace.unlink(postUnlink)
    if (postRename !== null) await namespace.rename(postRename[0], postRename[1])
  }
  return [stdout, io, execNode]
}
