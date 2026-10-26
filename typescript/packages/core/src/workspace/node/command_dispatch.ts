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

import type { ExecuteFn } from '../expand/types.ts'
import type { EntryGate } from '../../policy/types.ts'
import { sessionAccess } from '../../context/session_context.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { type SessionState, sessionEntry, setSessionEntry } from '../session/session.ts'
import { seedVar, setAttr } from '../session/state.ts'
import { type ShellVar, TempEnv, VarAttr } from '../../shell/variable.ts'
import {
  type RedirectRunner,
  currentCaller,
  noteRefusal,
  redirectRunnerFor,
  redirectSyntaxFor,
  runWithCaller,
  runWithRedirectPaths,
  isProgramInvocation,
  redirectPathsFor,
} from '../../context/session_context.ts'
import { guardDispatch } from '../abort.ts'
import { mergeSignals } from '../../utils/abort.ts'
import { type ByteSource, IOResult, type OutputState, materialize } from '../../io/types.ts'
import { commandRecords } from '../../observe/context.ts'
import type { OpRecord } from '../../observe/record.ts'
import { decodeText, encodeText } from '../../shell/bytes.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { getCommandName, getParts, getText, readRow, splitEnvPrefix } from '../../shell/helpers.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { ArithError, DiscardSignal, ExitSignal, TooManyMatches } from '../../shell/errors.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { PathSpec, wordText } from '../../types.ts'
import { Argv, expandArgv } from '../expand/argv.ts'
import { expandBoundaryGlobs } from '../expand/globs.ts'
import { expandNode } from '../expand/node.ts'
import { claimantFor, evaluatedFrom } from './occurrence.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { runExternal } from '../executor/command/external.ts'
import { argumentListTooLong } from '../executor/command/handler.ts'
import { fillTreeEnv, handleCommand, madeByCommand } from '../executor/command/command.ts'
import type { ExecuteNodeOpts } from '../executor/command/types.ts'
import { aliasCommandText, aliasMark, expandingAliases } from '../executor/builtins/alias/index.ts'
import { checkSyntax, syntaxErrorResult } from '../../shell/parse/index.ts'
import { findSyntaxIssue } from '../../shell/parse/syntax.ts'
import type { ParseScope } from '../../shell/parse/scope.ts'
import { INTERPRETER_NAMES } from '../lookup/constants.ts'
import { guardIO, maybeWithTimeout, runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import {
  PolicyDenied,
  postCommandGate,
  refusalOf,
  renderDeny,
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
  operandFollow,
  prepareMv,
  stripLinkOperands,
} from '../executor/builtins/index.ts'
import { BUILTINS } from '../executor/builtins/table.ts'
import { globPattern } from '../../utils/glob_walk.ts'
import { CycleError, globPrefixMatch } from '../../utils/path.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { Consumer, lookup, runtimeRefused, UNSUPPORTED_BUILTINS } from '../lookup/index.ts'
import { Admitted, admit, classifiedWords } from './admission.ts'

import { ensureVarVisible, gateRendering, sessionView } from '../session/state.ts'
import { postSessionGate, preSessionGate } from '../../policy/index.ts'
import { ExecutionNode } from '../types.ts'
import { concat } from '../../utils/bytes.ts'
import type { ExpandedWords } from './types.ts'

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
  signal?: AbortSignal,
  // The line's parse scope; only alias expansion needs it, and each
  // expansion parses in a fork released when it ends. Absent means an
  // alias is stored and printed but never expanded.
  parser?: ParseScope,
  // The agent the line is attributed to, which an approval request names.
  // The line's hand-off, which its gate claims on and runs on.
  handed?: HandOff,
  // Where a command that runs statements of its own (a function body, a
  // nested shell) writes them as they finish.
  sink?: JobConsole,
  // Filled with the words the command expanded to, so the caller knows what
  // the head ran as.
  expanded?: ExpandedWords,
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
            session.shopts.extglob ?? false,
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
  const view = sessionView(session, registry.policies, context.frame.diagnostics)
  // A readonly name before a command is refused before its value expands,
  // on the shell's own stderr, and the command runs without it; with no
  // command it is a plain assignment, refused once its value expands
  // (below), and the line is discarded.
  let refused = ''
  for (const p of assignmentNodes) {
    const atext = getText(p)
    const eq = atext.indexOf('=')
    if (eq < 0) continue
    const key = atext.slice(0, eq)
    if (name !== '' && view.isReadonly(key, false)) {
      refused += `bash: ${key}: readonly variable\n`
      continue
    }
    const rawVal = atext.slice(eq + 1)
    const valNodes = p.namedChildren.filter((c) => c.type !== NT.VARIABLE_NAME)
    const firstVal = valNodes[0]
    const v =
      firstVal !== undefined
        ? await ownWords(node, expandNode(firstVal, context, executeFn, callStack, view))
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
      // below goes through `seedVar`, which is the ungated entry point, so this
      // loop is the only place the rule can be asked.
      await preSessionGate(registry.policies, {
        verb: 'set',
        key: k,
        value: v,
        sessionId: session.sessionId,
      })
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      return writeRefused(err, name !== '' ? name : k)
    }
    if (session.readonlyVars.has(k)) {
      throw new DiscardSignal(encodeText(`bash: ${k}: readonly variable\n`))
    }
  }

  // `postSession` asks about each prefix write once it landed.
  const judgeLanded = async (olds: ReadonlyMap<string, ShellVar | null>): Promise<void> => {
    for (const [k, v] of prefixAssignments) {
      const old = olds.get(k) ?? null
      await postSessionGate(
        registry.policies,
        { verb: 'set', key: k, value: v, sessionId: session.sessionId },
        old === null ? null : gateRendering(old.value),
      )
    }
  }

  const restore = (saved: ReadonlyMap<string, ShellVar | null>): void => {
    for (const [k, prev] of saved) {
      if (prev === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete session.vars[k]
      } else {
        setSessionEntry(session.vars, k, prev)
      }
    }
  }

  if (prefixAssignments.length > 0 && name === '') {
    const olds = new Map(prefixAssignments.map(([k]) => [k, sessionEntry(session.vars, k) ?? null]))
    for (const [k, v] of prefixAssignments) seedVar(session, k, v)
    try {
      await judgeLanded(olds)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      restore(olds)
      return writeRefused(err, name)
    }
    const cmdLabel = prefixAssignments.map(([k, v]) => `${k}=${v}`).join(' ')
    return [null, new IOResult(), new ExecutionNode({ command: cmdLabel, exitCode: 0 })]
  }

  const savedEnvOverrides = new TempEnv()
  // Seeded once the command's words are expanded, since bash expands them
  // with the values from before the assignment: `x=new echo $x` prints the
  // old x and `IFS=, cmd $v` splits on the old IFS.
  const seedPrefix = async (command: string): Promise<void> => {
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
    // Judged before the command reads them; on a refusal the restore
    // below puts the old values back.
    await judgeLanded(savedEnvOverrides)
  }

  if (refused !== '' && sink !== undefined) {
    await sink.emit(Channel.STDERR, encodeText(refused))
    refused = ''
  }
  let settling: OutputState | null = null
  try {
    const [stdout, io, execNode] = await runCommandBody(
      recurse,
      dispatch,
      registry,
      namespace,
      executeFn,
      node,
      nonPrefixParts,
      context,
      stdinIn,
      callStack,
      jobTable,
      signal,
      handed,
      seedPrefix,
      sink,
      parser,
      expanded,
      new Set(prefixAssignments.map(([k]) => k)),
    )
    if (refused !== '') io.stderr = concat([encodeText(refused), await materialize(io.stderr)])
    // A run that starts as its output is read still runs under the prefix,
    // so the lines it shells out see it: the prefix ends as that output
    // settles.
    if (prefixAssignments.length > 0 && io.output?.settled === false) settling = io.output
    return [stdout, io, execNode]
  } catch (err) {
    if (!(err instanceof TooManyMatches)) throw err
    // The command a glob was given to does not run, as exec(2) refuses an
    // argument list too long; the line goes on.
    const stderr = argumentListTooLong(name, err.reason)
    return [
      null,
      new IOResult({ exitCode: 126, stderr }),
      new ExecutionNode({ command: name, exitCode: 126, stderr }),
    ]
  } finally {
    const frames = session.localFrames
    if (frames[frames.length - 1] === savedEnvOverrides) frames.pop()
    if (settling !== null) {
      settling.callbacks.push(() => {
        restore(savedEnvOverrides)
      })
    } else {
      restore(savedEnvOverrides)
    }
  }
}

/**
 * The node entries a glob `rm` never removed: those whose name the pattern
 * matched is one the session cannot see, which the backend's expansion met as
 * absent. Empty for a session that hides nothing. Mirrors Python's _unmet.
 */
function unmet(namespace: Namespace, session: SessionState, pattern: string): Set<string> {
  const links = namespace.sessionLinks(session)
  if (!links.hidesUnder('/')) return new Set()
  const depth = stripSlash(pattern).split('/').length
  const kept = new Set<string>()
  for (const path of namespace.nodes.keys()) {
    if (!globPrefixMatch(path, pattern)) continue
    if (!links.visible(`/${stripSlash(path).split('/').slice(0, depth).join('/')}`)) kept.add(path)
  }
  return kept
}

/**
 * What `rm` meets as absent, read before it runs: per glob operand the node
 * entries it never removes (`unmet`), and the literal operands the session
 * cannot see. Read afterwards, a link hidden only because its walk passed
 * through a directory the line removed reads as a visible dangling link, and
 * its node would go. Mirrors Python's _rm_unseen.
 */
function rmUnseen(
  namespace: Namespace,
  session: SessionState,
  operands: readonly (string | PathSpec)[],
): { kept: Map<string, Set<string>>; hidden: Set<string> } {
  const links = namespace.sessionLinks(session)
  const kept = new Map<string, Set<string>>()
  const hidden = new Set<string>()
  for (const item of operands) {
    if (!(item instanceof PathSpec)) continue
    if (item.pattern !== null) {
      const pattern = globPattern(item.virtual)
      kept.set(pattern, unmet(namespace, session, pattern))
    } else if (!links.visible(item.virtual)) {
      hidden.add(item.virtual)
    }
  }
  return { kept, hidden }
}

/** A prefix assignment a session policy refused: bash's line, exit 1. */
function writeRefused(err: PolicyDenied, command: string): Result {
  const stderr = encodeText(`bash: ${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr }),
    new ExecutionNode({ command, exitCode: 1, stderr }),
  ]
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
  context: EvaluationContext,
  stdinIn: ByteSource | null,
  callStack: CallStack | null,
  jobTable: JobTable | null,
  signalIn?: AbortSignal,
  handed?: HandOff,
  seedPrefix?: (command: string) => Promise<void>,
  sink?: JobConsole,
  parser?: ParseScope,
  expanded?: ExpandedWords,
  assigned: ReadonlySet<string> = new Set(),
): Promise<Result> {
  const session = context.session
  const stdin = stdinIn
  // A background job's kill channel rides the session; fold it in so
  // builtins (sleep) and the mount layer observe the kill.
  const signal = mergeSignals(signalIn, context.frame.abortSignal)
  // The command's place on the line, as the pass computed it, and the
  // entry point its nested evaluations re-enter through: a word that runs a
  // line (eval, source, xargs) is bound to this node, and a substitution
  // names its own node when it calls, so every nested line stands under
  // the node its text came from.
  const claimant = claimantFor(node, handed)
  const executeFn: ExecuteFn = (cmd, opts) => executeFnIn(cmd, { node, ...opts })

  const argv = await ownWords(
    node,
    expandArgv(
      parts,
      context,
      executeFn,
      callStack,
      registry,
      namespace.sessionLinks(session),
      sessionView(session, registry.policies, context.frame.diagnostics),
    ),
  )
  if (expanded !== undefined) expanded.words = [argv.name, ...argv.args]

  // Limits resolve against the expanded name, so `$CMD`-style
  // invocations get their real command's policy.
  // Mount, CLI and external dispatch own their resolved deadlines.
  const consumer = lookup(argv.name, session, registry, context.frame.routing)
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
      signal,
      readRow(node),
      redirectPathsFor(node),
      claimant,
      sink,
      redirectRunnerFor(node),
      parser,
      seedPrefix,
      assigned,
    ),
    timeout,
    argv.name !== '' ? argv.name : '?',
  )
  // A builtin that streams (xargs) runs on after it returns.
  let stdout = maybeWithTimeout(rawStdout, resolved, argv.name !== '' ? argv.name : '?')
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
  if (xtrace) {
    const existing = await materialize(io.stderr)
    io.stderr = concat([traceCommand([argv.name, ...argv.args]), existing])
  }
  return [stdout, io, execNode]
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
  signal?: AbortSignal,
  // The row the shell began reading the command on within its parse
  // (`readRow`), which only `alias`, `unalias` and `shopt` read: the
  // commands of one read keep the aliases it began with.
  row = 0,
  // The agent the line is attributed to, which an approval request names.
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
  seedPrefix?: (name: string) => Promise<void>,
  assigned: ReadonlySet<string> = new Set(),
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
  const refusedExternal = runtimeRefused(name, session, registry, context.frame.routing)
  const boundary = refusedExternal
    ? [...argv.operands]
    : await expandBoundaryGlobs(
        argv.operands,
        registry,
        namespace.sessionLinks(session),
        sessionAccess(session),
      )
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
  // Ahead of every admission of the command: the gate walks a mount's tree
  // under the managed values its run reads. A first fetch changes how the
  // words read (an env-filled required option lets the walk reach the leaf,
  // whose files are paths), so they are classified again.
  if (name !== '' && (await fillTreeEnv(name, argv.args, session, registry, assigned))) {
    const words = classifiedWords(name, argv.args, session, registry)
    argv = new Argv(argv.name, argv.args, words.slice(1), argv.prefix)
  }

  let admitted: Admitted | null = null
  // What the last admission was asked about: the redirect layer admits
  // each target before it opens it, and then the run admits the whole
  // statement, so the policies are asked again only for a target they
  // have not seen.
  let asked: string | null = null
  const guard = async (
    paths: readonly PathSpec[],
    given: ByteSource | null,
  ): Promise<Result | null> => {
    const key = [String(given === null), ...paths.map((p) => p.virtual)].join('\0')
    if (admitted !== null && asked === key) return null
    if (name !== '') {
      asked = key
      const verdict = await admit(
        name,
        [...argv.args],
        [...argv.operands],
        context.session,
        registry,
        namespace,
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
    try {
      await seedPrefix?.(name)
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      return writeRefused(err, name)
    }
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
        signal,
        row,
        claimant?.line ?? null,
        output,
        parser,
        admitted,
      )
    // A post method reads what the command did: its file records, gathered
    // as it runs and as its output drains, and its result node, settled
    // once the output has drained.
    const gated = admitted
    const policies = registry.policies
    const sessionId = context.session.sessionId
    const judging = gated !== null && (await policies.wantsFor('postCommand', sessionId))
    const watched = judging || (await policies.wantsFor('postExecute', sessionId))
    let mine: OpRecord[] = []
    // The command's own layer of the caller: once admitted, its gate.
    const outer = currentCaller()
    const result = await runWithCaller({ ...outer, gate: gated ?? outer.gate }, () =>
      commandRecords((records) => {
        mine = records
        return route()
      }, true),
    )
    if (!watched) return result
    const [stdout, io, node] = result
    const early = io.stderr ?? new Uint8Array()
    const saved = node.stderr
    // postCommand judges the command once its result is final: a streamed
    // output settles its exit code and the stderr it adds as it drains
    // (unless the command saved that itself, as an external one does), so the
    // method is asked when the stream ends or its reader stops, and at once
    // for output already whole. A refusal leaves what was sent as sent: exit
    // 126, the refusal line on stderr, the refusal record.
    const settle = async (): Promise<void> => {
      // A function hands back its last command's node, which keeps the
      // records that command made.
      node.exitCode = io.exitCode
      node.records.push(...mine)
      const late = io.stderr
      if (
        node.stderr === saved &&
        early instanceof Uint8Array &&
        late instanceof Uint8Array &&
        late.byteLength > early.byteLength &&
        early.every((byte, i) => late[i] === byte)
      )
        node.stderr = concat([node.stderr, late.subarray(early.byteLength)])
      if (!judging) return
      const ctx = gated.ctx
      const stderr = await materialize(io.stderr)
      io.stderr = stderr
      const action = await postCommandGate(
        policies,
        {
          ...ctx,
          exitCode: io.exitCode,
          stderr: new TextDecoder().decode(stderr),
          records: mine.map((r) => r.toDict()),
        },
        claimant,
        signal,
      )
      if (action === null) return
      const [err, code] = renderDeny(ctx.command, action)
      io.stderr = concat([stderr, err])
      io.exitCode = code
      node.exitCode = code
      node.stderr = concat([node.stderr, err])
      io.refusal = refusalOf(action)
      if (io.refusal !== null) noteRefusal(io.refusal)
    }
    if (stdout === null || stdout instanceof Uint8Array) {
      await settle()
      return result
    }
    const pulled = stdout[Symbol.asyncIterator]()
    const drained = async function* (): AsyncIterable<Uint8Array> {
      let done = false
      try {
        for (;;) {
          // Each pull runs the command's lazy reads; they are its own,
          // whoever is reading.
          const next = await commandRecords(async (more) => {
            try {
              return await pulled.next()
            } finally {
              mine.push(...more)
            }
          }, true)
          if (next.done === true) {
            done = true
            return
          }
          yield next.value
        }
      } finally {
        if (!done) await pulled.return?.()
        await settle()
      }
    }
    return [drained(), io, node]
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
  signal: AbortSignal | undefined,
  row: number,
  handed: HandOff | null,
  sink?: JobConsole,
  parser?: ParseScope,
  admission: EntryGate | null = null,
): Promise<Result> {
  const session = context.session
  // The half of `runArgv` past the gate, split out so the gate's verdict
  // can be bound around it.
  // Every handler below reaches the dispatcher through this one function,
  // so a line whose caller was already released starts no further op
  // between its operands (`rm l1 l2` with the first unlink held past
  // the grace), and a walk the index answers yields often enough for the
  // abort or timeout to fire.
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

  const routing = context.frame.routing
  const consumer = lookup(name, session, registry, routing)
  if (consumer === Consumer.EXTERNAL) {
    if (routing === undefined) throw new Error(`${name}: run outside a routed line`)
    return runExternal(argv, stdin, session, registry, routing, signal, sink)
  }

  // Shell builtins. One lookup: every executor-run builtin word maps to
  // a handler that takes the whole invocation, so the arms live beside
  // their workers (builtins/<word>/) rather than here. Job builtins and
  // the interpreters are not in the table; they route below.
  const builtin = BUILTINS.get(name)
  if (builtin !== undefined) {
    try {
      return await builtin({
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
    } catch (err) {
      // A value a builtin stores into an `-i` name did not evaluate: bash
      // discards the line in that builtin's voice (`bash: getopts: ?:
      // syntax error: ...`).
      if (err instanceof ArithError) throw err.signal(name, true)
      throw err
    }
  }

  // Pathname resolution (POSIX, `operandFollow`), ahead of every handler
  // below because the kernel resolves a path before the syscall, not inside
  // it. An operand a link loop stands in comes back refused (`walkError`)
  // rather than failing the line: the command meets ELOOP at its op and
  // words it per operand.
  if (namespace.nodes.size > 0 && operands.length > 0) {
    operands = await operandFollow(
      namespace.sessionLinks(session),
      dispatch,
      name,
      argv.words,
    )(operands)
    argv = argv.withOperands(operands)
  }

  // The programs below run here rather than on a mount, and every op one
  // issues is the program's, as a mount command's is: a rule scoped to it
  // reaches what `chmod -R` walks into, not only its operands.
  const made = madeByCommand(dispatch, admission)

  // Symlinks are namespace-backed: not bash builtins, not mount commands.
  // They mutate the addressing layer. `readlink -f/-e/-m` is canonicalization,
  // which falls through to the mount command.
  if (name === 'ln') {
    return await handleLn(namespace, made, session, operands)
  }
  if (name === 'readlink') {
    return await handleReadlink(namespace, made, session, operands)
  }

  // Extended attributes: the dispatcher's node table and the backend's own
  // facts; they read -h themselves.
  if (name === 'getfattr') {
    return await handleGetfattr(namespace, made, session, operands)
  }
  if (name === 'setfattr') {
    return await handleSetfattr(made, session, operands)
  }

  // Metadata commands (namespace-routed: resolve-then-setattr with
  // overlay fallback; they run their own link follow).
  if (name === 'chmod') {
    return handleChmod(namespace, made, session, operands)
  }
  if (name === 'chown') {
    return handleChown(namespace, made, session, operands)
  }
  if (name === 'chgrp') {
    return handleChgrp(namespace, made, session, operands)
  }
  if (name === 'touch') {
    return handleTouch(namespace, made, session, operands)
  }

  // Capacity (registry-routed: enumerates mounts, reports per-mount capacity;
  // never fabricates numbers).
  if (name === 'df') {
    return handleDf(registry, session, made, operands)
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
          namespace.sessionLinks(session),
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
        const prepared = await prepareMv(
          namespace.sessionLinks(session),
          dispatch,
          operands,
          argv.args,
          session.cwd,
        )
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

  // What rm's bookkeeping may drop is read before rm runs: removing a
  // directory can leave a hidden link dangling, which the session would see
  // afterwards, though rm met it as absent.
  const unseen =
    name === 'rm' && namespace.nodes.size > 0
      ? rmUnseen(namespace, session, operands)
      : { kept: new Map<string, Set<string>>(), hidden: new Set<string>() }

  // Default: mount-dispatched command
  const [source, io, execNode] = await handleCommand(
    recurse,
    dispatch,
    registry,
    dispatchArgv.words,
    context,
    stdin,
    callStack,
    jobTable,
    namespace,
    executeFn,
    handed ?? null,
    signal,
    sink,
    parser,
    admission,
  )

  const stdout = linkErrors.length > 0 ? await materialize(source) : source

  if (io.exitCode === 0 && namespace.nodes.size > 0) {
    if (name === 'rm') {
      // A removed path takes its node meta (overlay attrs) with it; a
      // removed dir purges everything underneath. Glob operands reach
      // here unexpanded (backend wrappers expand them), so the node
      // table matches the pattern itself. A name the session cannot see
      // was never removed: rm met it as absent (-f silenced that), so its
      // node stays.
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
          const pattern = globPattern(item.virtual)
          await namespace.unlinkGlob(pattern, unseen.kept.get(pattern))
        } else if (!unseen.hidden.has(item.virtual)) {
          await namespace.unlink(item.virtual)
          await namespace.purgeUnder(item.virtual)
        }
      }
    }
  }
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
