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
import { sessionEntry, setSessionEntry } from '../session/session.ts'
import { seedVar, setAttr } from '../session/state.ts'
import { TempEnv, VarAttr } from '../../shell/variable.ts'
import {
  type RedirectRunner,
  redirectRunnerFor,
  redirectSyntaxFor,
  runWithRedirectPaths,
  isProgramInvocation,
  redirectPathsFor,
  runWithAdmission,
} from '../../context/session_context.ts'
import { runWithOpPolicies } from '../../policy/policies.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { guardDispatch, mergeSignals } from '../abort.ts'
import { type ByteSource, IOResult, materialize } from '../../io/types.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import { decodeText, encodeText } from '../../shell/bytes.ts'
import { CallStack } from '../../shell/call_stack.ts'
import {
  getCommandName,
  getParts,
  getProcessSubBody,
  getProcessSubDirection,
  getText,
  readRow,
  splitEnvPrefix,
} from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { NodeType as NT, ProcessSubDirection } from '../../shell/types.ts'
import { PathSpec, wordText } from '../../types.ts'
import { Argv, expandArgv } from '../expand/argv.ts'
import { expandBoundaryGlobs } from '../expand/globs.ts'
import { type ExecuteFn, expandNode, childLine } from '../expand/node.ts'
import { claimantFor, evaluatedFrom } from './occurrence.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { runExternal } from '../executor/command/external.ts'
import { handleCommand } from '../executor/command/command.ts'
import type { ExecuteNodeOpts } from '../executor/command/types.ts'
import { aliasCommandText, aliasMark, expandingAliases } from '../executor/builtins/alias/index.ts'
import { checkSyntax, syntaxErrorResult } from '../../shell/parse/index.ts'
import { findSyntaxIssue } from '../../shell/parse/syntax.ts'
import type { ParseScope } from '../../shell/parse/scope.ts'
import { INTERPRETER_NAMES } from '../lookup/constants.ts'
import { guardIO, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import {
  PolicyDenied,
  resolveLimit,
  resolveProducer,
  type Claimant,
  type HandOff,
} from '../../policy/index.ts'
import { traceCommand } from '../../shell/xtrace.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import {
  acceptsLine,
  followPaths,
  handleChgrp,
  handleChmod,
  handleChown,
  handleDf,
  handleMount,
  handleExecPath,
  handleGetfattr,
  handleLn,
  handleReadlink,
  handleSetfattr,
  handleTouch,
  followDirectoryLinks,
  prepareMv,
  settleMoves,
  stripLinkOperands,
} from '../executor/builtins/index.ts'
import { BUILTINS } from '../executor/builtins/table.ts'
import { globPattern } from '../../utils/glob_walk.ts'
import { CycleError } from '../../utils/path.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import {
  Consumer,
  lookup,
  runtimeRefused,
  SLASH_KEEPS_LAST,
  UNSUPPORTED_BUILTINS,
  followsLastComponent,
  lsLinkMode,
} from '../lookup/index.ts'
import { Admitted, admit } from './admission.ts'

import { ensureVarVisible, sessionView } from '../session/state.ts'
import { preSessionGate } from '../../policy/index.ts'
import { ExecutionNode } from '../types.ts'
import { concat } from '../../io/cachable_iterator.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

/**
 * Await an expansion of the command's own words; an `ExitSignal` it raises
 * names the command, whose redirects bash had not applied. Mirrors Python's
 * _own_words.
 */
async function ownWords<T>(node: TSNodeLike, pending: Promise<T>): Promise<T> {
  try {
    return await pending
  } catch (err) {
    if (err instanceof ExitSignal) err.expanding = node.id ?? null
    throw err
  }
}

export async function executeCommand(
  recurse: (
    n: TSNodeLike,
    s: EvaluationContext,
    i: ByteSource | null,
    cs: CallStack | null,
    opts?: ExecuteNodeOpts,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  node: TSNodeLike,
  context: EvaluationContext,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: RouteDecision,
  signal?: AbortSignal,
  // The line's parse scope; only alias expansion needs it, and each
  // expansion parses in a fork released when it ends. Absent means an
  // alias is stored and printed but never expanded.
  parser?: ParseScope,
  // The agent the line is attributed to, which an approval request names.
  agentId = '',
  // The line's hand-off, which its gate claims on and runs on.
  handed?: HandOff,
  // Where a command that runs statements of its own (a function body, a
  // nested shell) writes them as they finish.
  sink?: JobConsole,
): Promise<Result> {
  const session = context.session
  const name = getCommandName(node)
  const [assignmentNodes, nonPrefixParts] = splitEnvPrefix(getParts(node))

  // bash rewrites the head word of a simple command before any other
  // expansion, textually, and reads the result as a fresh line: an alias
  // holding a pipe is a pipe. Only an unquoted plain word qualifies, and
  // `aliasValue` applies the rest of bash's rules (expand_aliases, the
  // same-line mark, the guards on inserted text). The rewritten line
  // runs through the same executor with the same call stack, so `$1`
  // inside a function still means the function's argument. A line run as a
  // program (`exec`, `env`, `find -exec`) is an argv, which no alias
  // rewrites.
  const headNode = nonPrefixParts[0]
  if (
    parser !== undefined &&
    (Object.keys(session.aliasView ?? session.aliases).length > 0 || session.aliasMarks.size > 0) &&
    !isProgramInvocation(session) &&
    headNode?.type === NT.COMMAND_NAME &&
    headNode.namedChildren[0]?.type === NT.WORD
  ) {
    const head = getText(headNode)
    const rewrite = aliasCommandText(session, node, headNode, aliasMark(session, readRow(node)))
    if (rewrite !== null) {
      const [line, owners] = rewrite
      const names = new Set(owners.flatMap((names) => [...names]))
      const previous = session.aliasExpansion
      const scope = parser.fork()
      try {
        const ast = scope.parse(line)
        const found =
          checkSyntax(
            line,
            new Set([...expandingAliases(session), ...names]),
            (name, at) => owners[at]?.has(name) ?? false,
          ) ?? findSyntaxIssue(ast)
        if (found !== null) {
          const io = syntaxErrorResult(found)
          const bad = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
          return [
            null,
            io,
            new ExecutionNode({ command: head, exitCode: io.exitCode, stderr: bad }),
          ]
        }
        const mapped = [...owners, new Set<string>()]
        session.aliasExpansion = {
          root: ast.id,
          owners: scope.sourceOffsets(line, ast).map((i) => {
            const owner = mapped[i]
            if (owner === undefined) throw new Error('alias source offset is out of bounds')
            return owner
          }),
          names,
        }
        // The rewritten line is read from this node, so it runs as a line
        // of its own under the word that named it: each invocation of one
        // alias is a place of its own on the line (`c && c` asks twice, as
        // its spelled-out form does), and what its gates claim is the
        // line's again at its end. Run on the line's own hand-off, both
        // reads stood at the same offsets of the same text and the second
        // ran on the first's nod.
        const expansion = handed === undefined ? null : evaluatedFrom(node, handed)
        try {
          return await runWithRedirectPaths(
            ast,
            [],
            () =>
              recurse(ast, context, stdinIn, callStack ?? new CallStack(), {
                ...(expansion === null ? {} : { handed: expansion }),
                ...(sink === undefined ? {} : { sink }),
              }),
            null,
            redirectSyntaxFor(node),
          )
        } finally {
          session.aliasExpansion = previous
          if (expansion !== null) registry.decisions.handUp(session.sessionId, expansion)
        }
      } finally {
        scope.release()
      }
    }
  }

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
      firstVal !== undefined
        ? await ownWords(
            node,
            expandNode(
              firstVal,
              context,
              executeFn,
              callStack,
              sessionView(session, registry.policies, context.frame.diagnostics),
            ),
          )
        : rawVal
    prefixAssignments.push([key, v])
  }

  for (const [k, v] of prefixAssignments) {
    // The hidden gate runs first, as in setVar: calling a hidden name
    // "readonly" would leak that it exists. Both branches below write
    // session.env raw (an `export` inside a function keeps its prefix
    // past the call), so ungated they would let a narrowed session
    // clobber the host's value.
    try {
      ensureVarVisible(session, k)
      // ...and `preSession` right after, with the value, because a
      // prefix assignment is a session write like any other and the form
      // exports it for the command. Only the hidden half was checked
      // here, so a deployment refusing `SECRET_*` still saw
      // `SECRET_K=leak printenv SECRET_K` print the secret: the seeding
      // below goes through `seedVar`, which is the ungated door, so this
      // loop is the only place the rule can be asked.
      await preSessionGate(registry.policies, {
        plane: 'env',
        verb: 'set',
        key: k,
        value: v,
        sessionId: session.sessionId,
      })
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      const stderr = encodeText(`bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr }),
        new ExecutionNode({ command: name !== '' ? name : k, exitCode: 1, stderr }),
      ]
    }
    if (session.readonlyVars.has(k)) {
      const err = encodeText(`bash: ${k}: readonly variable\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: name !== '' ? name : k, exitCode: 1, stderr: err }),
      ]
    }
  }

  if (prefixAssignments.length > 0 && name === '') {
    for (const [k, v] of prefixAssignments) seedVar(session, k, v)
    const cmdLabel = prefixAssignments.map(([k, v]) => `${k}=${v}`).join(' ')
    return [null, new IOResult(), new ExecutionNode({ command: cmdLabel, exitCode: 0 })]
  }

  const savedEnvOverrides = new TempEnv()
  // Seeded once the command's words are expanded, since bash expands them
  // with the values from before the assignment: `x=new echo $x` prints the
  // old x and `IFS=, cmd $v` splits on the old IFS.
  const seedPrefix = (command: string): void => {
    for (const [k, v] of prefixAssignments) {
      if (!savedEnvOverrides.has(k)) {
        savedEnvOverrides.set(k, sessionEntry(session.vars, k) ?? null)
      }
      // Exported for the duration, which is the whole point of the form:
      // `TOKEN=x printenv TOKEN` prints `x` because bash puts a prefix
      // assignment in the *command's environment*, not merely in the
      // shell. Seeding it plain left it invisible to every reader of
      // `envSnapshot` — the command's own env, an installed CLI, a guest
      // runtime — once that view narrowed to the exported set. The saved
      // record is put back below, so neither the value nor the attribute
      // outlives the command.
      seedVar(session, k, v)
      setAttr(session, k, VarAttr.Export)
    }
    // A function runs with the prefix as its temporary environment, a
    // scope under its own locals: `unset` inside reveals the caller's
    // value and `export` keeps the name.
    if (session.functions[command] !== undefined) session.localFrames.push(savedEnvOverrides)
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
      context,
      stdinIn,
      callStack,
      jobTable,
      runtimeBindings,
      routingDecision,
      signal,
      agentId,
      handed,
      seedPrefix,
      sink,
      parser,
    )
  } finally {
    const frames = session.localFrames
    if (frames[frames.length - 1] === savedEnvOverrides) frames.pop()
    for (const [k, prev] of savedEnvOverrides) {
      if (prev === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.vars[k]
      } else {
        setSessionEntry(session.vars, k, prev)
      }
    }
  }
}

async function runCommandBody(
  recurse: (
    n: TSNodeLike,
    s: EvaluationContext,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFnIn: ExecuteFn,
  node: TSNodeLike,
  parts: TSNodeLike[],
  name: string,
  context: EvaluationContext,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: RouteDecision,
  signalIn?: AbortSignal,
  agentId = '',
  handed?: HandOff,
  seedPrefix?: (command: string) => void,
  sink?: JobConsole,
  parser?: ParseScope,
): Promise<Result> {
  const session = context.session
  const stdin = stdinIn
  // A background job's kill channel rides the session; fold it in so
  // builtins (sleep) and the mount layer observe the kill.
  const signal = mergeSignals(signalIn, context.frame.abortSignal)
  // The command's place on the line, as the pass computed it, and the
  // door its nested evaluations re-enter through: a word that runs a
  // line (eval, source, xargs) is bound to this node, and a substitution
  // names its own node when it calls, so every nested line stands under
  // the node its text came from.
  const claimant = claimantFor(node, handed)
  const executeFn: ExecuteFn = (cmd, opts) => executeFnIn(cmd, { node, ...opts })

  // Input substitutions are buffered virtual files, not host pipes. Each
  // operand has its own lifetime; they never consume the caller's stdin.
  let dev: DevVFS | null = null
  const procSubInputs: (readonly [string, number])[] = []
  const procSubStderr: Uint8Array[] = []
  const cleanParts: TSNodeLike[] = []
  try {
    for (const p of parts) {
      if (p.type !== NT.PROCESS_SUBSTITUTION) {
        cleanParts.push(p)
        continue
      }
      if (getProcessSubDirection(p) === ProcessSubDirection.OUTPUT) {
        const err = encodeText('mirage: unsupported: process substitution >(...)\n')
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: name || 'process_sub', exitCode: 2, stderr: err }),
        ]
      }
      if (dev === null) {
        const [candidate] = registry.resolve('/dev/null')
        if (!(candidate instanceof DevVFS)) throw new Error('missing device filesystem')
        dev = candidate
      }
      const [path, allocation] = dev.allocateInput()
      procSubInputs.push([path, allocation])
      const inner = getProcessSubBody(p)
      if (inner !== '') {
        const io = await childLine(context, executeFn, inner, p, callStack)
        dev.setInput(path, allocation, await materialize(io.stdout))
        procSubStderr.push(await materialize(io.stderr))
      }
      cleanParts.push({ type: NT.WORD, text: path, children: [], namedChildren: [] })
    }

    const argv = await ownWords(
      node,
      expandArgv(
        cleanParts,
        context,
        executeFn,
        callStack,
        registry,
        namespace,
        sessionView(session, registry.policies, context.frame.diagnostics),
        routingDecision,
      ),
    )

    // Limits resolve against the expanded name, so `$CMD`-style
    // invocations get their real command's policy.
    // Mount, CLI and external dispatch own their resolved deadlines.
    const consumer = lookup(argv.name, session, registry, routingDecision)
    const ownsDeadline =
      !argv.name.includes('/') &&
      (consumer === Consumer.EXTERNAL ||
        consumer === Consumer.MOUNT ||
        consumer === Consumer.CLI ||
        INTERPRETER_NAMES.has(argv.name))
    const resolved =
      argv.name !== '' && !ownsDeadline
        ? resolveLimit(argv.name, [], null, null, registry.commandLimits, session.commandLimits)
        : null
    const timeout = resolved !== null ? resolved.timeoutSeconds : null
    // Capture xtrace before the body runs so `set -x` itself is not
    // traced (bash enables tracing only for the following commands). A body
    // that writes as it runs is traced before it starts.
    let xtrace = session.shellOptions.xtrace === true && argv.name !== ''
    if (xtrace && sink !== undefined) {
      await sink.emit(Channel.STDERR, traceCommand([argv.name, ...argv.args]))
      xtrace = false
    }
    const [rawStdout, io, execNode] = await runWithTimeout(
      runArgv(
        recurse,
        dispatch,
        registry,
        namespace,
        executeFn,
        argv,
        context,
        stdin,
        callStack,
        jobTable,
        runtimeBindings,
        routingDecision,
        signal,
        readRow(node),
        agentId,
        redirectPathsFor(node),
        claimant,
        sink,
        redirectRunnerFor(node),
        parser,
        seedPrefix,
      ),
      timeout,
      argv.name !== '' ? argv.name : '?',
    )
    let stdout = rawStdout
    if (io.producer === null && argv.name !== '') {
      // Builtins and other non-mount routes return no rider; stamp the
      // expanded name here so postExecute policies keyed on a command
      // (echo, printf, ...) still see it.
      io.producer = { command: argv.name, prefixes: [], declared: null }
    }
    if (!io.outputFinalized) {
      io.outputFinalized = true
      if (
        session.terminalOutput &&
        (session.execStdout === null || session.execStdout === '&1') &&
        io.producer !== null
      ) {
        const bound = resolveProducer(
          io.producer,
          (prefix, name) => registry.limitOverride(prefix, name),
          registry.commandLimits,
          session.commandLimits,
        )
        stdout = guardIO(stdout, io, bound, io.producer.command)
        execNode.exitCode = io.exitCode
      }
    }
    if (procSubStderr.length > 0) {
      const stderr = await materialize(io.stderr)
      io.stderr = concat([...procSubStderr, stderr])
      execNode.stderr = io.stderr
    }
    if (xtrace) {
      const existing = await materialize(io.stderr)
      io.stderr = concat([traceCommand([argv.name, ...argv.args]), existing])
    }
    return [
      procSubInputs.length > 0 && stdout !== null ? await materialize(stdout) : stdout,
      io,
      execNode,
    ]
  } finally {
    for (const [path, allocation] of procSubInputs) dev?.releaseInput(path, allocation)
  }
}

async function runArgv(
  recurse: (
    n: TSNodeLike,
    s: EvaluationContext,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatch: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  argv: Argv,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  runtimeBindings?: Record<string, Runtime>,
  routingDecision?: RouteDecision,
  signal?: AbortSignal,
  // The row the shell began reading the command on within its parse
  // (`readRow`), which only `alias`, `unalias` and `shopt` read: the
  // commands of one read keep the aliases it began with.
  row = 0,
  // The agent the line is attributed to, which an approval request names.
  agentId = '',
  // The statement's expanded redirect targets, judged with the line
  // because their I/O runs on the shell's own fds outside the admitted
  // command's gate window.
  redirects: readonly PathSpec[] = [],
  // The line's hand-off, which its gate claims on and runs on.
  claimant: Claimant | null = null,
  sink?: JobConsole,
  // Applies ordered redirects after command word expansion.
  runner: RedirectRunner | null = null,
  parser?: ParseScope,
  seedPrefix?: (name: string) => void,
): Promise<Result> {
  const session = context.session
  const name = argv.name

  // A glob whose directory holds a child mount cannot be pushed down to
  // one backend: the mount root is a child of that directory but its keys
  // live in another VFS, so the backend reports "no such file" for a
  // name its own listing shows. Expanding such a word here lets the
  // matches route per mount. It has to happen before the admission
  // policies below, not just before the follow policy: a word left
  // unexpanded reaches preCommand as the literal pattern, and
  // MountRootPolicy cannot recognize a mount root inside one, so
  // `tar -cf out.tar /base/*` would archive a whole backend the same
  // operand typed by hand is refused for.
  const refusedExternal = runtimeRefused(name, session, registry, routingDecision)
  const boundary = refusedExternal
    ? [...argv.operands]
    : await expandBoundaryGlobs(argv.operands, registry, namespace)
  const expandedWords = boundary.map(wordText)
  // Compared as words, not as a count: a glob that matches exactly one
  // name (`du /base/i*` where only the mount root matches) is still an
  // expansion, and dropping it routes the pattern to a backend that
  // cannot serve the child mount's keys.
  const typedWords = argv.operands.map(wordText)
  if (
    expandedWords.length !== typedWords.length ||
    expandedWords.some((w, i) => w !== typedWords[i])
  ) {
    argv = new Argv(argv.name, expandedWords, boundary, argv.prefix)
  }

  let admitted: Admitted | null = null
  const guard = async (
    paths: readonly PathSpec[],
    given: ByteSource | null,
  ): Promise<Result | null> => {
    if (name !== '') {
      const verdict = await admit(
        name,
        [...argv.args],
        [...argv.operands],
        context.session,
        registry,
        namespace,
        agentId,
        given,
        paths,
        signal,
        claimant,
      )
      if (!(verdict instanceof Admitted)) {
        return [
          null,
          new IOResult({
            exitCode: verdict.exitCode,
            stderr: verdict.stderr,
            refusal: verdict.refusal,
          }),
          new ExecutionNode({
            command: [name, ...argv.args].join(' '),
            stderr: verdict.stderr,
            exitCode: verdict.exitCode,
            refused: true,
          }),
        ]
      }
      admitted = verdict
    }
    return null
  }
  const runRedirected = async (
    given: ByteSource | null,
    output: JobConsole | undefined,
    paths: readonly PathSpec[],
  ): Promise<Result> => {
    seedPrefix?.(name)
    const refusal = await guard(paths, given)
    if (refusal !== null) return refusal
    // The admitted command's gate is bound for its run and handed back
    // after, so its own I/O can ask about the entries the gate did not see
    // and a nested line binds its own (see `Admitted`). The workspace's
    // policies bind in the same window, whether or not a gate judged the
    // line, so the command tier's policy guard can fire preVfs for the
    // backend I/O a handler performs.
    const route = () =>
      routeArgv(
        recurse,
        dispatch,
        registry,
        namespace,
        executeFn,
        argv,
        context,
        given,
        callStack,
        jobTable,
        runtimeBindings,
        routingDecision,
        signal,
        row,
        agentId,
        claimant?.line ?? null,
        output,
        parser,
      )
    const gated = admitted
    if (gated === null) return runWithOpPolicies(registry.policies, route)
    return runWithOpPolicies(registry.policies, () => runWithAdmission(gated, route))
  }
  if (runner !== null) return runner(runRedirected, guard, name, argv.args)
  return runRedirected(stdin, sink, redirects)
}

// Drop the refusal lines the command tier already wrote.
//
// A mount-mode refusal names the mount, not the operand, so the line the
// node table wrote for a refused link is the very line Mount.runCommand
// writes for the backend operands beside it on the same mount, and
// `rm dlink file` would say it twice. Compared on the trimmed text, so a
// trailing-newline difference between the two renderers cannot defeat
// it. Mirrors Python's unsaid.
export function unsaid(lines: readonly string[], said: Uint8Array): string[] {
  if (said.byteLength === 0) return [...lines]
  const spoken = new Set(
    decodeText(said)
      .split('\n')
      .map((t) => t.trim()),
  )
  return lines.filter((line) => !spoken.has(line.trim()))
}

async function routeArgv(
  recurse: (
    n: TSNodeLike,
    s: EvaluationContext,
    i: ByteSource | null,
    cs: CallStack | null,
  ) => Promise<Result>,
  dispatchIn: DispatchFn,
  registry: MountRegistry,
  namespace: Namespace,
  executeFn: ExecuteFn,
  argv: Argv,
  context: EvaluationContext,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  runtimeBindings: Record<string, Runtime> | undefined,
  routingDecision: RouteDecision | undefined,
  signal: AbortSignal | undefined,
  row: number,
  agentId: string,
  handed: HandOff | null,
  sink?: JobConsole,
  parser?: ParseScope,
): Promise<Result> {
  const session = context.session
  // The half of `runArgv` past the gate, split out so the gate's verdict
  // can be bound around it.
  // Every handler below reaches the op door through this one function,
  // so a line whose caller was already released starts no further op
  // between its operands (`rm l1 l2` with the first unlink held past
  // the grace). Python needs nothing here: its cancelled task never
  // reaches the next operand.
  const dispatch = guardDispatch(dispatchIn, mergeSignals(signal, context.frame.abortSignal))
  const name = argv.name
  const args = [...argv.args]
  let operands = [...argv.operands]

  // Path execution: bash hands a slash-carrying head word to the
  // loader, never to command lookup: no builtin, function, or CLI can
  // claim it. After the admission gate so a policy sees the line like
  // any other.
  if (name.includes('/')) {
    return handleExecPath(
      dispatch,
      executeFn,
      name,
      args,
      context,
      registry,
      namespace,
      stdin,
      sink,
      jobTable ?? undefined,
    )
  }

  // Unsupported bash builtins. Constructs the parser accepts but the
  // executor cannot honor. Returning a clear error lets LLMs detect a
  // capability gap instead of treating it as a missing binary.
  if (UNSUPPORTED_BUILTINS.has(name)) {
    const err = encodeText(`mirage: unsupported builtin: ${name}\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: name, exitCode: 2, stderr: err }),
    ]
  }

  const consumer = lookup(name, session, registry, routingDecision)
  if (consumer === Consumer.EXTERNAL) {
    return runExternal(argv, stdin, session, registry, routingDecision, signal)
  }

  // Shell builtins. One lookup: every executor-run builtin word maps to
  // a handler that takes the whole invocation, so the arms live beside
  // their workers (builtins/<word>/) rather than here. Job builtins and
  // the interpreters are not in the table; they route below.
  const builtin = BUILTINS.get(name)
  if (builtin !== undefined) {
    return builtin({
      argv,
      context,
      stdin,
      callStack,
      signal,
      row,
      dispatch,
      registry,
      namespace,
      executeFn,
      ...(parser === undefined ? {} : { parser }),
      ...(sink === undefined ? {} : { sink }),
      ...(jobTable === null ? {} : { jobTable }),
    })
  }

  // Pathname resolution (POSIX): every component of an operand but the
  // last resolves for every command, so `stat dlink/f2` reports f2 the
  // way GNU does. The last one resolves only for a command that follows
  // (open(2) rather than lstat(2)) or an operand typed with a trailing
  // slash, which POSIX reads as `dlink/.`. This runs ahead of every
  // handler below because the kernel resolves a path before the syscall,
  // not inside it. An operand a link loop stands in comes back refused
  // (`walkError`) rather than failing the line: the command meets ELOOP at
  // its op and words it per operand.
  if (namespace.nodes.size > 0 && operands.length > 0) {
    const lsMode = name === 'ls' ? lsLinkMode(argv.words) : null
    operands = followPaths(
      namespace,
      operands,
      lsMode !== null ? lsMode === 'all' : followsLastComponent(name, argv.words),
      !SLASH_KEEPS_LAST.has(name),
    )
    // ls resolves a command-line link only when it leads to a directory, and
    // only a stat can tell where it leads.
    if (lsMode === 'directory') operands = await followDirectoryLinks(namespace, dispatch, operands)
    argv = argv.withOperands(operands)
  }

  // Symlinks are namespace-backed: not bash builtins, not mount commands.
  // They mutate the addressing layer. `readlink -f/-e/-m` is canonicalization,
  // which falls through to the mount command.
  if (name === 'ln') {
    return await handleLn(namespace, dispatch, session, operands)
  }
  if (name === 'readlink') {
    return await handleReadlink(namespace, dispatch, session, operands)
  }

  // Extended attributes: the door's node table and the backend's own
  // facts; they read -h themselves.
  if (name === 'getfattr') {
    return await handleGetfattr(dispatch, session, operands)
  }
  if (name === 'setfattr') {
    return await handleSetfattr(dispatch, session, operands)
  }

  // Metadata commands (namespace-routed: resolve-then-setattr with
  // overlay fallback; they run their own link follow).
  if (name === 'chmod') {
    return handleChmod(namespace, dispatch, session, operands)
  }
  if (name === 'chown') {
    return handleChown(namespace, dispatch, session, operands)
  }
  if (name === 'chgrp') {
    return handleChgrp(namespace, dispatch, session, operands)
  }
  if (name === 'touch') {
    return handleTouch(namespace, dispatch, session, operands)
  }

  // Capacity (registry-routed: enumerates mounts, reports per-mount capacity;
  // never fabricates numbers).
  if (name === 'df') {
    return handleDf(registry, session, dispatch, operands)
  }
  if (name === 'mount') {
    return handleMount(registry, session, operands)
  }

  // Symlink-aware dispatch: reads follow links (open(2)); rm/mv act on
  // the link entry itself (lstat semantics).
  let linkErrors: string[] = []
  let dispatchArgv = argv
  if (namespace.nodes.size > 0) {
    try {
      // Both remove the link entry itself, which no backend can see;
      // unlink(1) is rm(1) restricted to one non-directory. Gated on the
      // line being one the command layer accepts, because this removal
      // happens before that layer parses and it cannot be taken back
      // (GNU refuses `rm --bogus dlink` and `unlink dlink other` with
      // the link still there).
      if (
        (name === 'rm' || name === 'unlink') &&
        acceptsLine(name, argv.args, operands, session.cwd)
      ) {
        const [rest, handled, stripErrors] = await stripLinkOperands(
          name,
          dispatch,
          namespace,
          operands,
          argv.args,
          session.cwd,
        )
        operands = rest
        linkErrors = stripErrors
        if (handled > 0 && !rest.some((a) => a instanceof PathSpec)) {
          if (linkErrors.length === 0) {
            return [null, new IOResult(), new ExecutionNode({ command: name, exitCode: 0 })]
          }
          const err = encodeText(linkErrors.join(''))
          return [
            null,
            new IOResult({ exitCode: 1, stderr: err }),
            new ExecutionNode({ command: name, exitCode: 1, stderr: err }),
          ]
        }
      } else if (name === 'mv') {
        const prepared = await prepareMv(namespace, dispatch, operands, argv.args, session.cwd)
        operands = prepared.items
        if (prepared.early !== null) return prepared.early
      }
    } catch (err) {
      if (err instanceof CycleError) {
        const errBytes = encodeText(`${name}: ${err.path}: Too many levels of symbolic links\n`)
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
    context,
    stdin,
    callStack,
    jobTable,
    runtimeBindings,
    namespace,
    routingDecision,
    agentId,
    executeFn,
    handed ?? null,
    signal,
    sink,
    parser,
  )

  if (io.exitCode === 0 && namespace.nodes.size > 0) {
    if (name === 'rm') {
      // A removed path takes its node meta (overlay attrs) with it; a
      // removed dir purges everything underneath. Glob operands reach
      // here unexpanded (backend wrappers expand them), so the node
      // table matches the pattern itself.
      for (const item of operands) {
        if (!(item instanceof PathSpec)) continue
        // The walk refused it, so rm removed nothing there (-f only
        // silenced the refusal), and the empty name's `virtual` is the
        // working directory: purging under it dropped every link the
        // directory held.
        if (item.walkError !== null) continue
        // A trailing slash asked for the directory, and rm refused (or -f
        // silenced the refusal). Nothing was removed, so nothing may be
        // purged: dropping the node here deleted the very link the slash
        // protects (GNU keeps it through `rm -rf dlink/`).
        if (item.rawPath.endsWith('/')) continue
        if (item.pattern !== null) {
          // A quoted metacharacter is a literal here too, so the node
          // table is matched with the same pattern the backend resolved
          // with.
          await namespace.unlinkGlob(globPattern(item.virtual))
        } else {
          await namespace.unlink(item.virtual)
          await namespace.purgeUnder(item.virtual)
        }
      }
    }
  }
  if (name === 'mv' && io.renames.length > 0) await settleMoves(namespace, io.renames)
  if (linkErrors.length > 0) {
    // A refused link operand fails the line the way a refused backend
    // operand does: its lines lead (they were reported first) and any
    // success stays a partial one. Merged after the bookkeeping above
    // so the operands the backend did remove still shed their node
    // meta.
    const tail = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array(0)
    io.stderr = concat([encodeText(unsaid(linkErrors, tail).join('')), tail])
    if (io.exitCode === 0) io.exitCode = 1
    const nodeTail = execNode.stderr
    execNode.stderr = concat([encodeText(unsaid(linkErrors, nodeTail).join('')), nodeTail])
    if (execNode.exitCode === 0) execNode.exitCode = 1
  }
  return [stdout, io, execNode]
}
