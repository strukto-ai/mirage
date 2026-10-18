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
  type CallerDispatchFn,
  currentCaller,
  getAdmission,
  sessionAccess,
} from '../../../context/session_context.ts'
import type { EntryGate } from '../../../policy/types.ts'
import type { EvaluationContext } from '../../evaluation.ts'
import { isBuiltinGrammar, registeredSpec } from '../../../commands/spec/builtins.ts'
import { STANDARD_AFTER_SCAN } from '../../../commands/spec/constants.ts'
import { spreadOperands } from '../../../commands/spec/flag_view.ts'
import { SPECS } from '../../../commands/spec/index.ts'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import type { JobConsole } from '../../../shell/console/index.ts'
import type { JobTable } from '../../../shell/job_table/index.ts'
import { PathSpec } from '../../../types.ts'
import { invokedEnvNames, suppliedEnvNames } from '../../../commands/cli/walk.ts'
import {
  PROGRAM_FILE_COMMANDS,
  prepareProgram,
  programFiles,
  valueRefusal,
} from '../../../commands/builtin/generic/program.ts'
import { type ParsedCommand, type ExecuteNodeFn, type Result } from './types.ts'
import { identityFrom } from '../../../commands/builtin/utils/identity.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { MountCommandUnsupported, type MountRegistry } from '../../mount/registry.ts'
import { makeCheckUnlink, makeStorageKey } from '../../mount/storage.ts'
import { Consumer, JOB_BUILTINS, dereferences, lookup, runsAs } from '../../lookup/index.ts'
import { EXEC_WRAPPERS } from '../../lookup/constants.ts'
import { type Runtime } from '../../../runtime/base.ts'
import type { RouteDecision } from '../../../runtime/routing/index.ts'
import { type SessionState, sessionEntry } from '../../session/session.ts'
import { abortable, mergeSignals } from '../../../utils/abort.ts'
import { ExecutionNode } from '../../types.ts'
import { RELAY_COMMANDS } from '../../../commands/builtin/generic/crossmount/constants.ts'
import { aggregateFor } from '../../../commands/builtin/generic/crossmount/detect.ts'
import type { OperandMount } from '../../../commands/builtin/generic/crossmount/types.ts'
import { globOptions, resolveGlobs } from '../../expand/globs.ts'
import {
  handleCrossMount,
  isCrossMount,
  type RunSingle,
} from '../../../commands/builtin/generic/crossmount/index.ts'
import { fanOutTraversal, runWithFanout, shouldFanOut } from '../fanout.ts'
import {
  findExprTail,
  parseFindExpression,
  type FindExpr,
} from '../../../commands/builtin/find_parse.ts'
import { resolveNewerRefs } from '../find_refs.ts'
import type { ExecuteFn } from '../../expand/types.ts'
import { FindParseError } from '../../../commands/errors.ts'
import { maybeWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import { resolveProducer, resolveLimit } from '../../../policy/index.ts'
import {
  type JobHandlerResult,
  handleDisown,
  handleFg,
  handleJobs,
  handleKill,
  handlePs,
  handleWait,
} from '../jobs.ts'
import { standardRequest } from '../../../commands/spec/standard.ts'

import { dropsMountCaches, handleCli, handleMountCli } from './cli.ts'
import { pathStat } from '../../mount/namespace/probe.ts'
import { Files } from '../../files.ts'
import {
  dropMountCaches,
  findStartPoints,
  nestedShell,
  runOnMount,
  type RunOnMountCtx,
} from './run.ts'
import type { FollowOperands, SessionView, StatPath } from '../../../view/types.ts'
import { applyFindActions } from '../find_action_dispatch.ts'
import { operandFollow } from '../builtins/links/links.ts'
import { sessionView } from '../../session/state.ts'
import { optionError, parseFlags } from './flags.ts'
import type { HandOff } from '../../../policy/types.ts'
import type { ParseScope } from '../../../shell/parse/scope.ts'
import { runShellFunction } from './functions.ts'
import {
  CWD_DEFAULT_RAW,
  defaultCwdOperand,
  mergeScopes,
  pathFlagScopes,
  routableScopes,
  optionLoopExits,
  routedOperands,
} from './routing.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'

// One handler per JOB_BUILTINS member but ps, which also takes the workspace
// user; lookup already narrowed the name.
const JOB_HANDLERS: Record<
  string,
  (
    jobTable: JobTable,
    textParts: string[],
    session: SessionState | null,
    view: SessionView | null,
    signal?: AbortSignal,
    sink?: JobConsole,
  ) => JobHandlerResult | Promise<JobHandlerResult>
> = {
  wait: handleWait,
  fg: handleFg,
  kill: handleKill,
  jobs: handleJobs,
  disown: handleDisown,
}

/**
 * Apply find's actions once, at the command boundary. Every runner below
 * this point (one mount, a fan-out over nested mounts, one native run per
 * cross-mount operand) only selects rows and hands them back as
 * `io.matchedRuns`; the actions run here over all of them together, so
 * a batched `-exec {} +` is one invocation across every start point, as
 * GNU's is, and a per-match action runs in start-point order.
 */
async function finishFind(
  stdout: ByteSource | null,
  io: IOResult,
  texts: readonly string[],
  registry: MountRegistry,
  context: EvaluationContext,
  executeFn: ExecuteFn | undefined,
  vfs: Files,
  statPath: StatPath,
  dispatch: CallerDispatchFn,
  stdin: ByteSource | null,
  starts: readonly PathSpec[],
  signal: AbortSignal | undefined,
): Promise<ByteSource | null> {
  const session = context.session
  const [newStdout, actionErr, actionExit] = await applyFindActions(
    stdout,
    io.matchedRuns,
    texts,
    registry,
    session.cwd,
    {
      ...(executeFn !== undefined ? { executeFn } : {}),
      session,
      vfs,
      statPath,
      dispatch,
      identity: identityFrom(sessionView(session, registry.policies, context.frame.diagnostics)),
      stdin,
      starts,
      ...(signal !== undefined ? { signal } : {}),
    },
  )
  if (actionErr.length > 0) {
    const existing = await materialize(io.stderr)
    io.stderr = concat([existing, actionErr])
  }
  if (io.exitCode === 0) io.exitCode = actionExit
  return newStdout
}

/**
 * Each path operand with what the cross-mount decision reads of it: the
 * mount that owns it, the reducer of what `cmdName` resolves to there, and
 * whether a mount sits below it. Mirrors Python's `_operand_mounts`.
 */
function operandMounts(
  registry: MountRegistry,
  cmdName: string,
  scopes: readonly PathSpec[],
): OperandMount[] {
  return scopes.map((scope) => {
    const mount = registry.tryMountFor(scope.virtual)
    return {
      path: scope,
      mount: mount?.prefix ?? null,
      aggregate: mount?.resolveCommand(cmdName)?.aggregate ?? null,
      nests: registry.descendantMounts(scope.virtual).length > 0,
    }
  })
}

/** The command's words as the line spelled them, an operand as typed.
 * Mirrors Python's spelled_words. */
function spelledWords(parts: readonly (string | PathSpec)[]): string[] {
  return parts.map((p) => (p instanceof PathSpec ? p.rawPath : p))
}

/**
 * Fetch the managed names the tree a mount serves under `name` reads. The
 * line's fill covers installed CLIs only: which mount's tree a head word
 * reaches is known only when the command runs, after any `cd` before it on the
 * line. The names are fetched ahead of the command's admission, as an
 * installed CLI's are, so the gate walks the tree under the values the run
 * reads; an env-filled required option would otherwise stop that walk short
 * of the leaf, and a writing leaf would read as a reader. A name the
 * invocation assigns (`TOKEN=x tok`, `skip`) is the invocation's, so it is
 * never fetched. A failed fetch throws SecretsError. Resolves to whether a
 * value was fetched, which changes how the words read. Mirrors Python's
 * `fill_tree_env`.
 */
export async function fillTreeEnv(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  skip: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  if (registry.fillEnv === undefined || registry.clis.get(name) !== null) return false
  const tree = registry.commandMount(name, [], session.cwd)?.cliFor(name) ?? null
  if (tree === null || lookup(name, session, registry) !== Consumer.MOUNT) return false
  const verbs = new Set(args.filter((w) => !w.startsWith('-')))
  const supplied = suppliedEnvNames(tree.spec, [...args])
  const names = new Set(
    [...invokedEnvNames(tree.spec, verbs)].filter((n) => !supplied.has(n) && !skip.has(n)),
  )
  const before = new Map([...names].map((n) => [n, sessionEntry(session.vars, n)]))
  await registry.fillEnv(session, names)
  return [...names].some((n) => sessionEntry(session.vars, n) !== before.get(n))
}

export async function handleCommand(
  executeNode: ExecuteNodeFn,
  dispatch: CallerDispatchFn,
  registry: MountRegistry,
  parts: readonly (string | PathSpec)[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  runtimeBindings?: Record<string, Runtime>,
  namespace?: Namespace,
  routingDecision?: RouteDecision<Runtime>,
  executeFn?: ExecuteFn,
  handed: HandOff | null = null,
  signal?: AbortSignal,
  // Where a function body writes its statements as they finish.
  sink?: JobConsole,
  parser?: ParseScope,
  admission: EntryGate | null = getAdmission(),
): Promise<Result> {
  const session = context.session
  if (parts.length === 0) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }

  const head = parts[0]
  if (head === undefined) {
    return [null, new IOResult(), new ExecutionNode({ command: '', exitCode: 0 })]
  }
  let cmdName = typeof head === 'string' ? head : head.virtual
  const cmdStr = parts.map((p) => (typeof p === 'string' ? p : p.virtual)).join(' ')

  if (JOB_BUILTINS.has(cmdName) && jobTable !== null) {
    const textParts = parts.map((p) => (typeof p === 'string' ? p : p.virtual))
    if (cmdName === 'ps') {
      return handlePs(jobTable, textParts, session, sessionView(session, registry.policies))
    }
    const handler = JOB_HANDLERS[cmdName]
    if (handler !== undefined) {
      return handler(
        jobTable,
        textParts,
        session,
        sessionView(session, registry.policies, context.frame.diagnostics),
        mergeSignals(signal, context.frame.abortSignal),
        // `fg` is the one job builtin that writes before it blocks.
        sink,
      )
    }
  }

  const funcBody = session.functions[cmdName]
  if (funcBody !== undefined) {
    if (parser === undefined) throw new Error('function invocation requires a parse scope')
    return runShellFunction(
      executeNode,
      cmdName,
      funcBody,
      parser,
      parts.slice(1),
      context,
      stdin,
      callStack,
      jobTable,
      handed,
      registry.decisions,
      sink,
      executeFn ?? null,
    )
  }

  // Every op the command or CLI issues from here is made by the command,
  // its gate included, so a rule scoped to a CLI reaches its own reads, and
  // so does every mount run below: one run, a fan-out or a cross-mount.
  const commandDispatch = dispatch
  dispatch = (op, path, args, kwargs, report, caller) =>
    commandDispatch(
      op,
      path,
      args,
      kwargs,
      report,
      caller ?? { ...currentCaller(), ruleGate: admission },
    )
  // The command's own files keep no ledger: the dispatcher accounts for the line.
  const commandFiles = (follow: FollowOperands | null): Files =>
    new Files(dispatch, null, namespace ?? null, (path) => registry.mountOwner(path), {
      prefixes: () => registry.mountPrefixes(),
      visibility: () => session.visibility,
      follow,
      ledger: false,
    })

  // Installed CLIs: dispatch by name, never by operand path. Sits
  // below functions (a user can wrap an installed CLI, bash-style)
  // and above every mount branch (a CLI consults no mount).
  // A CLI that works on files rather than an API (`git`) reaches them
  // through `ctx.vfs`, the session's files made by the command; the
  // rest never look.
  const cliInstall = registry.clis.get(cmdName)
  if (cliInstall !== null) {
    const cliSignal = mergeSignals(signal, context.frame.abortSignal)
    // A leaf that waits on its service keeps running; the caller's abort
    // releases the invocation, as it does for `wait`.
    return abortable(
      handleCli(
        cliInstall,
        parts,
        session,
        stdin,
        {
          ...(executeFn !== undefined ? { shell: nestedShell(executeFn, session, cliSignal) } : {}),
          ...(cliSignal !== undefined ? { signal: cliSignal } : {}),
          commandLimits: registry.commandLimits,
          entries: registry.runtimeEntries,
          vfs: commandFiles(null),
          session: sessionView(session, registry.policies, context.frame.diagnostics),
          ...(registry.processView === undefined
            ? {}
            : { processes: registry.processView(session) }),
          ...(routingDecision === undefined ? {} : { routing: routingDecision }),
        },
        dropsMountCaches(cliInstall.cli) ? () => dropMountCaches(registry) : null,
      ),
      mergeSignals(signal, context.frame.abortSignal),
    )
  }

  // A wrapper execs the program it names, past every function and CLI; the
  // session's allow list judges the name it typed.
  const typed = cmdName
  const wrapped = runsAs(cmdName, registry) !== cmdName ? EXEC_WRAPPERS.get(cmdName) : undefined
  if (wrapped !== undefined) {
    const [runs, option] = wrapped
    cmdName = runs
    parts = [runs, option, ...parts.slice(1)]
  }

  const follow =
    namespace !== undefined
      ? operandFollow(namespace, dispatch, cmdName, parts, session.visibility)
      : undefined
  const files = commandFiles(follow ?? null)
  const runCtx: RunOnMountCtx = {
    admission,
    ...(signal !== undefined ? { signal } : {}),
    ...(follow !== undefined ? { follow } : {}),
    registry,
    context,
    dispatch,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(runtimeBindings !== undefined ? { runtimeBindings } : {}),
    ...(routingDecision !== undefined ? { routingDecision } : {}),
    ...(executeFn !== undefined ? { executeFn } : {}),
  }

  // Unknown name: nobody registers it; fail like bash before any
  // backend work. The admission policies (fired upstream at the
  // dispatch chokepoint) stay ahead of this so
  // protective refusals keep their specific messages.
  if (lookup(typed, session, registry) === Consumer.UNKNOWN) {
    const errBytes = encodeText(`${typed}: command not found\n`)
    return [
      null,
      new IOResult({ exitCode: 127, stderr: errBytes }),
      new ExecutionNode({ command: cmdStr, exitCode: 127, stderr: errBytes }),
    ]
  }

  // A command tree a mount serves runs by name on that mount, like an
  // installed CLI: its walk, not a spec parse, reads the words, so it sits
  // ahead of the help, cross-mount and flag-parsing branches below, and of
  // the operand a bare ls, du, tree, find or grep implies.
  const treeMount = registry.commandMount(cmdName, [], session.cwd)
  const tree = treeMount?.cliFor(cmdName) ?? null
  if (treeMount !== null && tree !== null) {
    await treeMount.ensureReady()
    const treeSignal = mergeSignals(signal, context.frame.abortSignal)
    return handleMountCli(
      treeMount,
      tree,
      parts,
      session,
      stdin,
      {
        ...(executeFn !== undefined ? { shell: nestedShell(executeFn, session, treeSignal) } : {}),
        ...(treeSignal !== undefined ? { signal: treeSignal } : {}),
        commandLimits: registry.commandLimits,
        vfs: files,
        session: sessionView(session, registry.policies, context.frame.diagnostics),
        ...(registry.processView === undefined ? {} : { processes: registry.processView(session) }),
      },
      (path) => registry.tryMountFor(path),
      follow,
    )
  }

  if (cmdName in CWD_DEFAULT_RAW) {
    const operand = defaultCwdOperand(parts, cmdName, registry, session.cwd, stdin)
    if (operand !== null) {
      // Where GNU's implied `.` sits: after the pattern for grep/rg
      // (the first positional is the pattern), right after the command
      // name for find/tree/du/ls (find's expression tokens must stay
      // behind the path).
      parts =
        cmdName === 'grep' || cmdName === 'rg'
          ? [...parts, operand]
          : [head, operand, ...parts.slice(1)]
    }
  }

  const pathScopes: PathSpec[] = []
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]
    if (p instanceof PathSpec) pathScopes.push(p)
  }
  const rawArgv = parts.slice(1).map((p) => (typeof p === 'string' ? p : p.virtual))

  // --help and --version answer from the package, never from a backend, so
  // they are served before mount permission checks and cross-mount routing:
  // otherwise `rm --version /ro/x` hits the read-only refusal,
  // `cat --version /ram/a /disk/b` parses against the shared spec, which
  // carries no injected --version, and fails as an unknown option, and
  // `mv --help /ram/a /disk/b` reaches the cross-mount relay, which bypasses
  // the registered wrapper that answers help and MOVED THE FILE instead of
  // printing the page.
  const cmdMount = registry.mountForCommand(cmdName)
  const cmdSpec = cmdMount?.specFor(cmdName) ?? null
  const standardOut = standardRequest(cmdName, cmdSpec, rawArgv)
  const builtinSpec = SPECS[cmdName]
  if (
    standardOut !== null &&
    STANDARD_AFTER_SCAN.has(cmdName) &&
    isBuiltinGrammar(cmdName, cmdSpec) &&
    builtinSpec !== undefined
  ) {
    const refused = valueRefusal(
      cmdName,
      parseFlags(parts.slice(1), registeredSpec(cmdName, builtinSpec), cmdName, session.cwd)
        .flagKwargs,
    )
    if (refused !== null) {
      return [
        null,
        refused,
        new ExecutionNode({
          command: cmdStr,
          exitCode: refused.exitCode,
          stderr: await materialize(refused.stderr),
        }),
      ]
    }
  }
  if (standardOut !== null) {
    return [standardOut, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }

  let prepared: ParsedCommand | null = null
  if (PROGRAM_FILE_COMMANDS.has(cmdName)) {
    const programSpec = SPECS[cmdName]
    if (programSpec !== undefined) {
      const candidate = parseFlags(
        parts.slice(1),
        registeredSpec(cmdName, programSpec),
        cmdName,
        session.cwd,
      )
      if (programFiles(cmdName, candidate.flagKwargs).length > 0) {
        prepared = candidate
        const refusal = optionError(cmdName, prepared)
        if (refusal !== null) {
          const [msg, code] = refusal
          return [
            null,
            new IOResult({ exitCode: code, stderr: msg }),
            new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
          ]
        }
        const [texts, flags, remaining, error] = await prepareProgram(
          cmdName,
          prepared.texts,
          prepared.flagKwargs,
          stdin,
          dispatch,
          prepared.paths,
        )
        if (error !== null) {
          return [
            null,
            error,
            new ExecutionNode({
              command: cmdStr,
              exitCode: error.exitCode,
              stderr: await materialize(error.stderr),
            }),
          ]
        }
        stdin = remaining
        prepared = { ...prepared, texts, flagKwargs: flags }
        pathScopes.splice(0, pathScopes.length, ...prepared.paths)
      }
    }
  }

  // Path-valued flags (e.g. shuf --output=/dst/out) own a mount just like
  // positional operands, so they join routing and mount validation instead of
  // being dropped whenever a positional path is also present.
  // The empty name joins onto the working directory in `virtual` but names
  // no path there, so it routes nowhere: the line runs where its other
  // operands (or the cwd) put it, and that run's op guards refuse it. A line
  // is not cross-mount because one of its words is empty.
  // A prepared program line already holds its positional operands.
  let routingScopes: PathSpec[] = []
  let flagScopes: PathSpec[] = []
  if (!optionLoopExits(cmdName, cmdMount?.specFor(cmdName) ?? null, rawArgv, session.cwd)) {
    const routed = routableScopes(
      cmdName,
      prepared !== null
        ? pathScopes
        : routedOperands(cmdName, rawArgv, session.cwd, parts.slice(1), pathScopes),
    )
    flagScopes = pathFlagScopes(cmdName, rawArgv, session.cwd)
    routingScopes = mergeScopes(routed, flagScopes).filter((s) => s.walkError !== 'ENOENT')
  }

  let findExprTokens: string[] | null = null
  if (cmdName === 'find') {
    findExprTokens = findExprTail(rawArgv)
    let findExpr: FindExpr
    try {
      findExpr = parseFindExpression(findExprTokens)
    } catch (err) {
      if (err instanceof FindParseError) {
        const errBytes = encodeText(`${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: errBytes }),
          new ExecutionNode({ command: cmdStr, stderr: errBytes, exitCode: 1 }),
        ]
      }
      throw err
    }
    if (findExpr.newer.length > 0) {
      // Every -newer reference is statted through the dispatcher here,
      // once, before any backend parses the expression.
      const [rewritten, refErr] = await resolveNewerRefs(
        findExprTokens,
        findExpr.newer,
        registry,
        session.cwd,
        (path) => pathStat(dispatch, path),
        namespace ?? null,
        dereferences(cmdName, parts),
      )
      if (refErr !== null) {
        return [
          null,
          new IOResult({ exitCode: 1, stderr: refErr }),
          new ExecutionNode({ command: cmdStr, stderr: refErr, exitCode: 1 }),
        ]
      }
      findExprTokens = rewritten
    }
  }

  // Path-valued flags count: `cp -t /other/mount/dir src` spans mounts
  // exactly like a positional destination would.
  if (isCrossMount(cmdName, operandMounts(registry, cmdName, routingScopes), flagScopes)) {
    // Parse against the shared spec so flags and text operands do not
    // depend on the source mount: raw argv would hand flag tokens ("-c")
    // to the generic as the search pattern. The bound single-mount runner
    // lets the strategy runners execute each operand natively on its
    // owning mount.
    // Registered, not declared: the registry injects --help/--version into
    // every spec, so parsing the declaration here made the same word mean
    // two things by mount count -- `cat --vers=x /ram/a` was
    // `option '--version' doesn't allow an argument` and the two-mount line
    // was `unrecognized option '--vers=x'`.
    const sharedSpec = SPECS[cmdName] ?? cmdMount?.specFor(cmdName) ?? undefined
    const csParsed =
      prepared ??
      parseFlags(
        parts.slice(1),
        sharedSpec !== undefined ? registeredSpec(cmdName, sharedSpec) : null,
        cmdName,
        session.cwd,
      )
    let csFlags = csParsed.flagKwargs
    const csTexts = findExprTokens ?? csParsed.texts
    const csRefusal = optionError(cmdName, csParsed)
    if (csRefusal !== null) {
      const [msg, code] = csRefusal
      return [
        null,
        new IOResult({ exitCode: code, stderr: msg }),
        new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
      ]
    }
    // A path option's value (sort -o, cp -t, csplit -f) routes to its owning
    // mount but is not an input. Parsed operands preserve aliases, order, and
    // repeated path values. find's expression is not the spec's grammar, so
    // its start points are the words classified as paths.
    let csScopes = cmdName === 'find' ? pathScopes : csParsed.paths
    if (RELAY_COMMANDS.has(cmdName)) {
      // STREAM and FANOUT (and a custom command's reducer) run each operand
      // natively on its mount, which expands the operand's glob. RELAY sees every operand at once (wc's
      // layout, cp's sources), so its glob operands must expand here; an
      // unmatched glob stays the literal word, like bash. One operand at a
      // time, so join's option loop sees each match where its glob was typed.
      const groups: PathSpec[][] = []
      for (const scope of csScopes) {
        const expanded = await resolveGlobs(
          [scope],
          registry,
          false,
          namespace ?? null,
          globOptions(session),
        )
        groups.push(expanded.filter((p): p is PathSpec => typeof p !== 'string'))
      }
      csScopes = groups.flat()
      csFlags = spreadOperands(
        csFlags,
        groups.map((group) => group.map((p) => p.rawPath)),
      )
    }
    const runSingle: RunSingle = (name, ps, ts, fk, opts) =>
      runOnMount(runCtx, name, ps, ts, fk, opts ?? {})
    // A per-operand native run is single-mount by construction, so a
    // traversal operand holding nested mounts has to fan out inside it,
    // exactly as the same operand would on a line of its own.
    const csStat: StatPath = (path) => pathStat(dispatch, path)
    const runOperand = runWithFanout(
      runSingle,
      registry,
      session.cwd,
      files,
      sessionView(session, registry.policies, context.frame.diagnostics),
      mergeSignals(signal, context.frame.abortSignal),
      dispatch,
      follow,
    )
    const [csStdout0, csIo] = await handleCrossMount(
      cmdName,
      csScopes,
      csTexts,
      csFlags,
      dispatch,
      runOperand,
      stdin,
      makeStorageKey(registry),
      files,
      sessionView(session, registry.policies, context.frame.diagnostics),
      session.cwd,
      spelledWords(parts.slice(1)),
      aggregateFor(cmdName, operandMounts(registry, cmdName, csScopes)),
      makeCheckUnlink(registry, sessionAccess(session)),
      follow,
    )
    const csExec = new ExecutionNode({
      command: cmdStr,
      stderr: await csIo.materializeStderr(),
      exitCode: csIo.exitCode,
    })
    let csStdout = csStdout0
    if (cmdName === 'find') {
      csStdout = await finishFind(
        csStdout,
        csIo,
        csTexts,
        registry,
        context,
        executeFn,
        files,
        csStat,
        dispatch,
        stdin,
        csScopes,
        mergeSignals(signal, context.frame.abortSignal),
      )
      csExec.exitCode = csIo.exitCode
      csExec.stderr = await csIo.materializeStderr()
    }
    if (csParsed.warnings.length > 0) {
      const csWarn = encodeText(csParsed.warnings.map((w) => `${cmdName}: ${w}\n`).join(''))
      const csExisting = await materialize(csIo.stderr)
      csIo.stderr = concat([csWarn, csExisting])
      csExec.stderr = concat([csWarn, csExec.stderr])
    }
    // The native sub-runs carry their own mount's scope; the cross-mount
    // command as a whole is bounded by the strictest cap across the
    // operand mounts, regardless of which sub-run merged last.
    const mounts: MountEntry[] = []
    for (const s of pathScopes) {
      // a scope outside any mount contributes nothing here
      const m = registry.tryMountFor(s.virtual)
      if (m !== null) mounts.push(m)
    }
    csIo.producer = {
      command: cmdName,
      prefixes: mounts.map((m) => m.prefix),
      declared: null,
    }
    csExec.paths = pathScopes
    return [
      maybeWithTimeout(
        csStdout,
        resolveLimit(cmdName, mounts, null, null, registry.commandLimits, session.commandLimits),
        cmdName,
      ),
      csIo,
      csExec,
    ]
  }

  // Path-flag targets count: a command bound to one mount cannot write its
  // output through another.
  if (routingScopes.length >= 2) {
    const mountPrefixes = new Set<string>()
    for (const s of routingScopes) {
      // a scope outside any mount contributes nothing here
      const m = registry.tryMountFor(s.virtual)
      if (m !== null) mountPrefixes.add(m.prefix)
    }
    if (mountPrefixes.size > 1) {
      const prefixesStr = [...mountPrefixes].sort(compareCodePoints).join(', ')
      const err = encodeText(
        `${cmdName}: paths span multiple mounts (${prefixesStr}), cross-mount not supported\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1 }),
      ]
    }
  }

  let mount: MountEntry | null
  try {
    mount = await registry.resolveMount(cmdName, routingScopes, session.cwd)
  } catch (err) {
    if (err instanceof MountCommandUnsupported) {
      const errBytes = encodeText(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: cmdStr, stderr: errBytes, exitCode: 1 }),
      ]
    }
    throw err
  }
  if (mount === null) {
    const err = encodeText(`${cmdName}: command not found`)
    return [
      null,
      new IOResult({ exitCode: 127, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 127 }),
    ]
  }
  const parsedLine =
    prepared ?? parseFlags(parts.slice(1), mount.specFor(cmdName), cmdName, session.cwd)
  const { paths: parsedPaths, flagKwargs, warnings: parseWarnings } = parsedLine
  const textsRaw = parsedLine.texts
  const refusal = optionError(cmdName, parsedLine)
  if (refusal !== null) {
    const [msg, code] = refusal
    return [
      null,
      new IOResult({ exitCode: code, stderr: msg }),
      new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
    ]
  }
  const texts = findExprTokens ?? textsRaw
  // The start points are the path words before the expression; the
  // spec's rest slot would otherwise read an -exec word as one.
  const paths =
    findExprTokens !== null
      ? findStartPoints(parts.slice(1), findExprTokens, mount.specFor(cmdName), session.cwd)
      : parsedPaths
  if (findExprTokens !== null) {
    // `multiple: true` on find value-flags makes parseToKwargs emit arrays;
    // bespoke backend wrappers read these as scalars. Migrated backends read
    // the expression from `texts` and ignore flagKwargs.
    for (const [key, value] of Object.entries(flagKwargs)) {
      if (Array.isArray(value)) {
        const last = value.at(-1)
        if (last !== undefined) flagKwargs[key] = last
      }
    }
  }
  const warnBytes =
    parseWarnings.length > 0
      ? encodeText(parseWarnings.map((w) => `${cmdName}: ${w}\n`).join(''))
      : null

  const singleStat: StatPath = (path) => pathStat(dispatch, path)
  if (shouldFanOut(cmdName, paths, flagKwargs, registry)) {
    const [fanOut0, fanIo, fanNode] = await fanOutTraversal(
      cmdName,
      paths,
      texts,
      flagKwargs,
      registry,
      mount,
      session.cwd,
      cmdStr,
      stdin,
      files,
      sessionView(session, registry.policies, context.frame.diagnostics),
      mergeSignals(signal, context.frame.abortSignal),
      dispatch,
      (name, ps, ts, fk, opts) =>
        runOnMount(runCtx, name, ps, ts, fk, { ...opts, argv: spelledWords(parts.slice(1)) }),
      follow,
    )
    let fanOut = fanOut0
    if (cmdName === 'find') {
      fanOut = await finishFind(
        fanOut,
        fanIo,
        texts,
        registry,
        context,
        executeFn,
        files,
        singleStat,
        dispatch,
        stdin,
        paths,
        mergeSignals(signal, context.frame.abortSignal),
      )
      fanNode.exitCode = fanIo.exitCode
      fanNode.stderr = await materialize(fanIo.stderr)
    }
    if (warnBytes !== null) {
      const existing = await materialize(fanIo.stderr)
      fanIo.stderr = concat([warnBytes, existing])
      fanNode.stderr = concat([warnBytes, fanNode.stderr])
    }
    return [fanOut, fanIo, fanNode]
  }

  const [rawStdout, io] = await runOnMount(runCtx, cmdName, paths, texts, flagKwargs, {
    stdin,
    mount,
    resolveHint: routingScopes[0] ?? null,
    argv: spelledWords(parts.slice(1)),
  })
  let stdout = rawStdout
  if (cmdName === 'find') {
    stdout = await finishFind(
      stdout,
      io,
      texts,
      registry,
      context,
      executeFn,
      files,
      singleStat,
      dispatch,
      stdin,
      paths,
      mergeSignals(signal, context.frame.abortSignal),
    )
  }
  if (warnBytes !== null) {
    const existing = await materialize(io.stderr)
    io.stderr = concat([warnBytes, existing])
  }
  const resolved =
    io.producer !== null
      ? resolveProducer(
          io.producer,
          (prefix, name) => registry.limitOverride(prefix, name),
          registry.commandLimits,
          session.commandLimits,
        )
      : null
  stdout = maybeWithTimeout(stdout, resolved, cmdName)
  io.stderr = maybeWithTimeout(io.stderr, resolved, cmdName)
  const stderrBytes = await io.materializeStderr()
  const exec = new ExecutionNode({
    command: cmdStr,
    stderr: stderrBytes,
    exitCode: io.exitCode,
    paths,
  })
  return [stdout, io, exec]
}
