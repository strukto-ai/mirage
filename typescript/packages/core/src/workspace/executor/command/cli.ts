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
import { CommandSpec, type CommandSpecInit } from '../../../commands/spec/types.ts'

import {
  ARGPARSE_EXIT,
  directoryRefusal,
  clapMissingOperands,
  leafRefusal,
} from '../../../commands/cli/refusal.ts'
import { missCondition, pathStat } from '../../mount/namespace/probe.ts'
import { FileType, wordText, PathSpec, type Limit } from '../../../types.ts'
import { flagOccurrences } from '../../../commands/spec/flag_view.ts'
import type { ProcessView } from '../../../process/view.ts'
import { CLAP_EXIT, CLI_CONFIG_ENV, GIT_LONG_OPTIONS } from '../../../commands/cli/constants.ts'
import type { CLI, CLIHandler } from '../../../commands/cli/types.ts'
import type { CommandFnResult, Context } from '../../../commands/config.ts'
import { listedNode, nodeHelp, ownsArgv, walk } from '../../../commands/cli/walk.ts'
import { type RunResult, type ScriptSource, type ShellFn } from '../../../runtime/types.ts'
import type { FollowOperands, SessionView } from '../../../view/types.ts'
import type { Files } from '../../files.ts'
import { flagKwargName } from '../../../commands/spec/constants.ts'
import { UsageStyle, Argument, type FlagValue } from '../../../commands/spec/types.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { maybeWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import type { CLIInstall } from '../../cli/types.ts'
import type { MountEntry } from '../../mount/mount.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { resolveLimit } from '../../../policy/index.ts'
import { runtimeForLanguage } from '../../../runtime/routing/decide.ts'
import type { RouteDecision } from '../../../runtime/routing/index.ts'
import { admissionDenial } from './run.ts'
import { answered, cliVoice, runHandler } from './handler.ts'
import { runOutput, runtimeUnavailable } from '../../../commands/builtin/general/interpreter.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { WorkspaceRuntime } from '../../../runtime/workspace.ts'
import { optionError, parseFlags } from './flags.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { IdSource } from '../../../utils/ids.ts'

// A textual rest operand is a CLI node's pass-through form: parsed under
// unknownIsOperand, it takes the undeclared dashed tokens the node does not
// refuse, which is what a program parsing its own argv needs. 'str', not
// 'path', so nothing is cwd-resolved or routed. Only that parse reads the
// rest kind this way: a GNU command's textual rest is a list of operands,
// which is why basename has one and still refuses an option it does not know.
const PASSTHROUGH_REST = new Argument('args', { metavar: '', nargs: '*' })

/**
 * The spec a leaf's argv parses against, and who answers `--help`.
 *
 * Usually mirage: a leaf declares its grammar, the parser enforces it,
 * and `--help` is injected the way argparse's add_help does. Two nodes
 * answer for themselves instead. A leaf that declares `--help` asked for
 * the flag, so it is delivered rather than intercepted. And a script root
 * that declares no grammar (ownsArgv) has the whole line forwarded:
 * refusing `--width` on behalf of a program that accepts it would make
 * the tier unusable, since a YAML `clis:` entry cannot declare options at
 * all. Returns the spec to parse with and whether the injected `--help`
 * is mirage's to answer. CLI init accepts instance fields, so each
 * spread is a plain init bag (the withHelpSupport pattern).
 */
function parseSpecFor(
  leaf: CommandSpec,
  style: UsageStyle = UsageStyle.ARGPARSE,
  passthrough = false,
): [CommandSpec, boolean] {
  if (passthrough) {
    const spec: CommandSpecInit = leaf
    return [new CommandSpec({ ...spec, arguments: [...leaf.arguments, PASSTHROUGH_REST] }), false]
  }
  if (!leaf.addHelp || leaf.arguments.some((argument) => argument.names.includes('--help')))
    return [leaf, false]
  return [listedNode(leaf, style), true]
}

/**
 * Pick the workspace entry that runs a script leaf.
 *
 * A `runtime:` pin names the entry, and the entry must speak the
 * script's language, so `runtime: monty` on a `.mjs` fails loud
 * instead of feeding JS to a python interpreter. Without a pin the
 * program runs where this line runs its language's own interpreter
 * (the tier's head word, `python3` or `node`), so the runtime capturing
 * that command, or a route policy, places it, and a line every capturer
 * refused is refused here too (126). The first entry speaking the
 * language serves when the workspace serves that interpreter itself, or
 * outside a workspace line, where `routing` is absent
 * (runtimeForLanguage); a placement on a runtime that does not run the
 * script's language is refused like such a pin. Every other refusal names
 * the world so the fix (add or rename an entry) is visible (127). Mirrors
 * Python's `_select_runtime`.
 */
function selectRuntime(
  prog: string,
  leaf: CLI,
  entries: readonly Runtime[],
  routing?: RouteDecision<Runtime>,
): [LanguageRuntime, null] | [null, IOResult] {
  const script = leaf.script
  if (script === null) {
    throw new Error(`selecting a runtime for '${prog}' without a script`)
  }
  const known = entries.map((entry) => `'${entry.name}'`).join(', ') || 'none'
  let chosen: Runtime | null | undefined
  if (leaf.runtime !== null) {
    chosen = entries.find((entry) => entry.name === leaf.runtime) ?? null
    if (chosen === null) {
      return [
        null,
        missing(`${prog}: unknown runtime: '${leaf.runtime}' (workspace runtimes: ${known})`),
      ]
    }
  } else {
    const entry = runtimeForLanguage(entries, script.language)
    if (entry === null) {
      return [
        null,
        missing(
          `${prog}: no workspace runtime runs ${script.language} scripts (workspace runtimes: ${known})`,
        ),
      ]
    }
    const head = (entry.constructor as { commands?: readonly string[] }).commands?.[0]
    chosen =
      routing === undefined || head === undefined
        ? entry
        : head in routing.bindings
          ? routing.bindings[head]
          : routing.fallback
    if (chosen === null || chosen === undefined) return [null, admissionDenial(prog)]
    if (chosen instanceof WorkspaceRuntime) chosen = entry
  }
  if (!(chosen instanceof LanguageRuntime) || chosen.language !== script.language) {
    return [
      null,
      missing(`${prog}: runtime '${chosen.name}' does not run ${script.language} scripts`),
    ]
  }
  return [chosen, null]
}

/** The 127 a script CLI answers when no entry can run its program. */
function missing(message: string): IOResult {
  return new IOResult({ exitCode: 127, stderr: encodeText(`${message}\n`) })
}

/**
 * Render the invocation onto the selected runtime as one `-c` run.
 *
 * The script tier's whole contract, the one a native binary could also
 * honor: the program is named (argv slot 0, so its own messages read
 * `pager:` and a renamed install names itself), re-parses `argv` (the
 * verbatim tokens after the head), reads piped stdin, and finds the
 * install's config as `MIRAGE_CLI_CONFIG` (JSON) in its environment.
 * The outcome converts through the interpreter handlers' one mapping
 * (runOutput).
 *
 * @param config the install's config, handed to the program as JSON.
 * @param ctx the line's context.
 * @param script the install's embedded program.
 * @param runtime the selected interpreter entry.
 * @param prog the installed head word.
 * @param timeout the limit, which an engine that blocks its event loop
 *   must interrupt itself at.
 * @param signal aborted when the limit trips.
 * @param settle settles the runtime once the program ends, however it ends.
 */
async function scriptOutput(
  config: unknown,
  ctx: Context,
  script: ScriptSource,
  runtime: LanguageRuntime,
  prog: string,
  timeout: number | null,
  signal: AbortSignal,
  settle: ((runtime: Runtime) => Promise<void>) | undefined,
): Promise<[Uint8Array | null, IOResult]> {
  const env: Record<string, string> = { ...ctx.env }
  if (config !== null && config !== undefined) {
    env[CLI_CONFIG_ENV] = JSON.stringify(config)
  }
  // A .mjs source needs the engine's module mode, the same bit the js
  // command derives from the operand's extension.
  const flags: Record<string, FlagValue> = { c: script.source, scriptCli: true }
  if (script.module) flags.module = true
  // Renamed to the installed head word, which the program names itself by.
  const spec: CommandSpecInit = ctx.spec ?? {}
  let result: RunResult
  try {
    result = await runtime.execute([], [...(ctx.argv ?? [])], {
      ...ctx,
      flags,
      env,
      spec: new CommandSpec({ ...spec, name: prog }),
      signal,
      ...(timeout !== null && timeout > 0 ? { timeoutSeconds: timeout } : {}),
    })
  } catch (err) {
    // A limit interrupt is named after the CLI, as the workspace's own
    // timer names it.
    if (err instanceof CommandTimeoutError) throw new CommandTimeoutError(prog, err.seconds)
    // The interpreter is missing, not the program: 127, as the
    // interpreter command answers for the same runtime.
    if (!runtimeUnavailable(err)) throw err
    return [null, missing(`${prog}: ${err.message}`)]
  } finally {
    await settle?.(runtime)
  }
  return runOutput(result)
}

/**
 * Workspace facts the dispatcher can offer but most CLIs do not want: an API
 * client needs no filesystem, while `git` is nothing but one. Forwarded whole
 * onto the leaf's opts bag, so a leaf that does not read them ignores them and
 * there is no allowlist of filesystem-aware CLIs to keep in step (the same rule
 * `links` follows for mount commands).
 */
export interface CLIContext {
  shell?: ShellFn
  signal?: AbortSignal
  commandLimits?: Readonly<Record<string, Limit>>
  /**
   * The workspace's ordered runtime world, which a script leaf selects
   * its interpreter from; absent (outside a workspace) refuses script
   * installs.
   */
  entries?: readonly Runtime[]
  /**
   * The session's files, run as the line's session with the command's gate,
   * for a CLI whose subject is files rather than an API.
   */
  vfs?: Files
  session?: SessionView
  processes?: ProcessView
  /** The line's placement, which a script leaf runs its program under. */
  routing?: RouteDecision<Runtime>
  /**
   * Lands what a script leaf's runtime holds and drops the caches its
   * program may have gone past; absent outside a workspace.
   */
  settle?: (runtime: Runtime) => Promise<void>
  /** The workspace's source, which the leaf's `ctx.ids` draws from. */
  ids?: IdSource
}

/**
 * Whether this CLI reaches a service past the dispatcher.
 *
 * Its write verbs then go past the dispatcher's per-path invalidation, so the
 * mounts its client may reach drop their caches after one
 * (`MountRegistry.dropCaches`). Two roots do that: one with a `configModel`
 * (an account CLI, initialized from it) and a script root, whose config is
 * opaque by construction and whose program may reach anything. A root with
 * neither (`git`) has no service to reach; its writes go through the
 * dispatcher, which invalidates as it goes, so a blanket drop would only cost
 * every other mount a reload. Mirrors Python's `reaches_service`.
 */
export function reachesService(spec: CLI): boolean {
  return spec.configModel !== null || spec.script !== null
}

/**
 * Execute a line whose head word is an installed CLI.
 *
 * Dispatch is by NAME: the install resolves the program tree and the
 * validated config; no mount is consulted and no operand path picks a
 * backend (the one executor divergence from mount commands). The walk
 * consumes subcommand words and group options; the leaf's own argv
 * uses the shared CommandSpec parser. The leaf gets the line's one Context,
 * built here and nowhere else: an fn leaf runs as
 * `fn(accessor, paths, texts, ctx)`, a script
 * leaf runs its embedded program on a workspace runtime
 * (scriptOutput), so usage refusals, limits, and classification all
 * happen in front of either tier. Help too, for every node that declared
 * a grammar to render it from (parseSpecFor). The workspace facts in
 * `context` reach a verb on its `ctx`, so a verb that never reads `ctx.vfs`
 * cannot touch a mount.
 */
export async function handleCli(
  install: CLIInstall,
  parts: readonly (string | PathSpec)[],
  session: SessionState,
  stdin: ByteSource | null = null,
  context: CLIContext = {},
  dropCaches: (() => Promise<void>) | null = null,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  // Taken before the first await, so a removal racing this line waits for
  // the leaf and its output rather than closing the accessor under them.
  const release = install.activity.acquire()
  try {
    const [stdout, io, node] = await runCli(install, parts, session, stdin, context, dropCaches)
    return [stdout === null ? null : install.activity.hold(stdout), io, node]
  } finally {
    release()
  }
}

/**
 * A line a command tree's walk resolved to one leaf, parsed and ready to
 * run. Mirrors Python's `LeafCall`.
 */
export interface LeafCall {
  /** The line's words as typed, for the record. */
  cmdStr: string
  /** The words after the head as typed. */
  argv: readonly string[]
  /** The head and the verb path, the name a message, a limit and the output guards read. */
  prog: string
  /** The canonical verb path below the head. */
  path: readonly string[]
  leaf: CommandSpec
  handler: CLIHandler
  /** The group and leaf flags, one bag. */
  flags: Record<string, FlagValue>
  paths: PathSpec[]
  texts: string[]
  /** What the parse warned about, said ahead of the leaf's own stderr. */
  warnings: readonly string[]
}

/**
 * Walk a line down a command tree to the leaf it names and parse the
 * leaf's words, or answer the line without running anything.
 *
 * The walk consumes subcommand words and group options; the leaf's own argv
 * uses the shared CommandSpec parser. Help, usage refusals and an operand
 * base that is no directory are answered here, for an installed CLI and a
 * tree a mount serves alike. Mirrors Python's `walk_leaf`.
 */
export async function walkLeaf(
  name: string,
  cli: CLI,
  parts: readonly (string | PathSpec)[],
  session: SessionState,
  vfs: Files | undefined,
): Promise<LeafCall | [ByteSource | null, IOResult, ExecutionNode]> {
  // Words re-enter string space as typed (wordText): the walk owns
  // interpretation, so a quoted "Lunch?" must not arrive as the
  // glob-classified absolute /Lunch?. Leaf path operands are resolved
  // later by parseFlags against the session cwd.
  const words = parts.map((p) => wordText(p))
  const cmdStr = words.join(' ')
  const argv = words.slice(1)

  // The walk takes the same environment the leaf parse below does, so
  // a group-level option declaring `Argument.env` fills at its own
  // level; without it the fetched credential never enters groupFlags.
  const result = walk(name, cli.spec, argv, session.cwd, envSnapshot(session))
  if (result.leaf === null) {
    const stderr = result.stream === 'stderr' ? result.output : new Uint8Array(0)
    const stdout = result.stream === 'stdout' ? result.output : null
    const io = new IOResult({ exitCode: result.exitCode, stderr })
    return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: result.exitCode, stderr })]
  }

  if (vfs !== undefined) {
    const dispatch = vfs.dispatch
    for (const base of result.operandBases) {
      const info = await pathStat(dispatch, base)
      if (info !== null && info.type === FileType.DIRECTORY) continue
      const reason = info === null ? await missCondition(dispatch, base) : 'ENOTDIR'
      const [stderr, code] = directoryRefusal(name, base.rawPath, reason, cli.spec.usageStyle)
      return [
        null,
        new IOResult({ exitCode: code, stderr }),
        new ExecutionNode({ command: cmdStr, exitCode: code, stderr }),
      ]
    }
  }

  const prog = [name, ...result.path].join(' ')
  const leaf = result.leaf
  const handler = cli.handlers[result.path.join(' ')]
  if (handler === undefined) throw new Error(`cli '${prog}': missing handler`)
  // No injected --version: that is a GNU coreutils convention, not an
  // argparse one.
  const [parseSpec, mirageHelp] = parseSpecFor(leaf, cli.spec.usageStyle, ownsArgv(cli))

  // The dialect is the root's, not the leaf's: a program answers in one voice
  // at every level.
  const style = cli.spec.usageStyle
  // The environment goes into the parse, not on top of it: an option
  // declaring one is coerced, choice-checked, path-resolved and credited
  // against required exactly as a typed value is.
  // git resolves an abbreviated long option against the verb's own full table
  // (parse-options), and its revision walkers take whole words only.
  const abbreviations =
    cli.spec.name === 'git' ? (GIT_LONG_OPTIONS.get(result.path.join(' ')) ?? []) : undefined
  const parsed = parseFlags(
    [...result.argv],
    parseSpec,
    prog,
    session.cwd,
    envSnapshot(session),
    true,
    abbreviations,
  )
  const { paths, texts, flagKwargs, warnings } = parsed
  if (mirageHelp && flagKwargs.help === true) {
    const helpText = encodeText(nodeHelp(prog, parseSpec, style))
    return [helpText, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }

  const refusal = optionError(prog, parsed)
  let msg: Uint8Array | null = null
  let shown: Uint8Array | null = null
  let code = 0
  if (refusal !== null) {
    ;[msg, code, shown] = leafRefusal(style, refusal[0], parsed, result.path.join(' '), leaf)
  } else if (parsed.missingRequiredOperands.length > 0 && style === UsageStyle.CLAP) {
    msg = clapMissingOperands(
      prog,
      parseSpec,
      parsed.missingRequiredOperands,
      parsed.typedDests,
      session.env,
    )
    code = CLAP_EXIT
  } else if (parsed.missingRequiredOperands.length > 0 && style === UsageStyle.ARGPARSE) {
    const usage = nodeHelp(prog, parseSpec, style).split('\n')[0] ?? ''
    const missing = [...new Set(parsed.missingRequiredOperands)].join(', ')
    msg = encodeText(`${usage}\n${prog}: error: the following arguments are required: ${missing}\n`)
    code = ARGPARSE_EXIT
  }
  if (msg !== null) {
    return [
      shown,
      new IOResult({ exitCode: code, stderr: msg.length > 0 ? msg : null }),
      new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
    ]
  }

  // Group flags merge into the one bag: ancestor/descendant collisions
  // are a build-time CLI error, so a group flag can never shadow a
  // leaf flag.
  const flags: Record<string, FlagValue> = {}
  for (const [spelling, value] of Object.entries(result.groupFlags)) {
    flags[flagKwargName(spelling)] = value
  }
  Object.assign(flags, flagKwargs)
  flagOccurrences(flags).push(...flagOccurrences(flagKwargs))
  // Only the injected flag is dropped; a leaf that declared --help
  // itself is handed the value it asked for.
  if (mirageHelp) delete flags.help
  return {
    cmdStr,
    argv,
    prog,
    path: result.path,
    leaf,
    handler,
    flags,
    paths,
    texts,
    warnings,
  }
}

/**
 * Execute a line whose head word names a command tree a mount serves.
 *
 * The tree a VFS was handed (or one registered on its mount) is walked
 * exactly as an installed CLI's is (`walkLeaf`: verbs, help, usage
 * refusals, the leaf's parse); the leaf then runs on the mount, on its
 * accessor and under its refusals (`MountEntry.runLeaf`), with its own
 * limit: the profile's, then the mount's and the workspace's entry for the
 * verb path, then the leaf's declared one. A tree runs on the mount serving
 * its name, never by operand path, and its leaf keys that mount's accessor by
 * each operand: the operands the leaf parse resolved are followed through the
 * link table as the router follows a mount command's (`follow`), and one
 * another mount holds (`owner`) is refused before the leaf runs. Mirrors
 * Python's `handle_mount_cli`.
 */
export async function handleMountCli(
  mount: MountEntry,
  cli: CLI,
  parts: readonly (string | PathSpec)[],
  session: SessionState,
  stdin: ByteSource | null = null,
  context: CLIContext = {},
  owner?: (path: string) => MountEntry | null,
  follow?: FollowOperands,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  const walked = await walkLeaf(cli.spec.name, cli, parts, session, context.vfs)
  if (Array.isArray(walked)) return walked
  const limit = resolveLimit(
    walked.prog,
    [],
    walked.handler.limit,
    mount.commandLimits.get(walked.prog) ?? null,
    context.commandLimits,
    session.commandLimits,
  )
  const signal = context.signal
  const paths =
    follow === undefined
      ? walked.paths
      : (await follow([...walked.paths])).filter((p): p is PathSpec => p instanceof PathSpec)
  const foreign = paths.find(
    (p) => owner !== undefined && p.rawPath !== '-' && owner(p.virtual) !== mount,
  )
  if (foreign !== undefined) {
    const msg = encodeText(
      `${walked.prog}: ${foreign.rawPath}: not on ${mount.prefix}, the mount serving ${cli.spec.name}\n`,
    )
    return [
      null,
      new IOResult({ exitCode: 1, stderr: msg }),
      new ExecutionNode({ command: walked.cmdStr, exitCode: 1, stderr: msg }),
    ]
  }
  const run = (ctx: Context): Promise<CommandFnResult> =>
    mount.runLeaf(
      walked.prog,
      cli,
      walked.handler,
      paths,
      walked.texts,
      signal === undefined ? ctx : { ...ctx, signal },
      limit,
    )
  return runWalked(walked, session, stdin, context, limit, run)
}

/** handleCli's body, run while the install is held. */
async function runCli(
  install: CLIInstall,
  parts: readonly (string | PathSpec)[],
  session: SessionState,
  stdin: ByteSource | null,
  context: CLIContext,
  dropCaches: (() => Promise<void>) | null,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  const walked = await walkLeaf(install.name, install.cli, parts, session, context.vfs)
  if (Array.isArray(walked)) return walked
  const { prog, handler: binding } = walked

  // The outer timer bounds the whole invocation; the runtime deadline
  // also interrupts engines that block their event loop. Unlike Python's
  // asyncio cancellation, racing a promise does not stop its work.
  const limit = resolveLimit(
    prog,
    [],
    binding.limit,
    null,
    context.commandLimits,
    session.commandLimits,
  )
  const timeout = limit?.timeoutSeconds ?? null
  const script = install.cli.script
  let start: (ctx: Context, signal: AbortSignal) => Promise<[ByteSource | null, IOResult]>
  if (script !== null) {
    const [runtime, refused] = selectRuntime(
      prog,
      install.cli,
      context.entries ?? [],
      context.routing,
    )
    if (runtime === null) {
      // The interpreter is missing, not the command: 127 like an
      // interpreter command no runtime entry captures, or 126 when this
      // line's capturers all refused it.
      const stderr = await materialize(refused.stderr)
      return [
        null,
        new IOResult({ exitCode: refused.exitCode, stderr }),
        new ExecutionNode({ command: walked.cmdStr, exitCode: refused.exitCode, stderr }),
      ]
    }
    start = (ctx, signal) =>
      scriptOutput(install.config, ctx, script, runtime, prog, timeout, signal, context.settle)
  } else {
    const fn = binding.fn
    if (fn === null) {
      // validateCli guarantees fn XOR subcommands XOR script and walk
      // only returns handler-bearing nodes as leaf; reaching this is a
      // bug.
      throw new Error(`walk returned a leaf without a handler for '${prog}'`)
    }
    // Defer the call into the promise: a synchronously-thrown leaf error
    // must land in the runner's catch arms, exactly as when the call sat
    // inside its try.
    start = (ctx) =>
      answered(Promise.resolve().then(() => fn(install.accessor, walked.paths, walked.texts, ctx)))
  }
  const run = (ctx: Context): Promise<CommandFnResult> => {
    const abort = new AbortController()
    const body = start(ctx, abort.signal)
    // Racing a promise does not stop its work: a body, or a renderer of the
    // rows it handed over, still running past its timeout keeps the
    // install's accessor until the answer settles.
    const settled = install.activity.acquire()
    // The leaf's `write` is the one answer: the gate hands it to policy as
    // `CommandContext.write`, and the cache reads it too, so a verb that can
    // mutate (`gh api` under any method) costs the mounts a reload rather
    // than a stale read, and so does one that failed, timed out or was
    // cancelled after its request may have landed.
    return runHandler(
      body,
      prog,
      limit,
      { command: prog, prefixes: [], declared: binding.limit ?? null },
      cliVoice(prog),
      {
        abort,
        settle: settled,
        ...(binding.write && dropCaches !== null ? { drop: dropCaches } : {}),
        ...(script !== null ? { frame: false } : {}),
        ...(ctx.vfs !== undefined ? { vfs: ctx.vfs } : {}),
      },
    )
  }
  return runWalked(walked, session, stdin, context, limit, run)
}

/**
 * Run a walked leaf with the one Context a leaf gets, and record it.
 *
 * The leaf's declared limit bounds the handler body and its streams,
 * exactly like mount dispatch: without the wrap a blocking leaf hangs
 * forever and an unbounded-output leaf ignores its own limits. A failure
 * the runner framed is recorded as it is; an answer gets the parse's
 * warnings ahead of its stderr and the limit's stream guards. Mirrors
 * Python's `run_walked`.
 */
export async function runWalked(
  walked: LeafCall,
  session: SessionState,
  stdin: ByteSource | null,
  context: CLIContext,
  limit: Limit | null,
  run: (ctx: Context) => Promise<CommandFnResult>,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  let active = true
  const shell: ShellFn = async (line, data = null) => {
    if (!active || context.signal?.aborted === true) {
      throw new Error('CLI shell is no longer active')
    }
    if (context.shell === undefined) throw new Error('CLI shell is unavailable')
    return context.shell(line, data)
  }
  // Most CLIs never read the files: an API client has no filesystem, while
  // `git` is nothing but one. Absent outside a workspace, so a verb that
  // needs a mount refuses there on its own.
  const ctx: Context = {
    stdin,
    flags: walked.flags,
    cwd: PathSpec.fromStrPath(session.cwd),
    env: envSnapshot(session),
    argv: walked.argv,
    spec: walked.leaf,
    ...(context.vfs !== undefined ? { vfs: context.vfs } : {}),
    ...(context.session !== undefined ? { session: context.session } : {}),
    ...(context.processes === undefined ? {} : { processes: context.processes }),
    ...(context.shell !== undefined ? { shell } : {}),
    ...(context.ids === undefined ? {} : { ids: context.ids }),
  }
  let out: CommandFnResult
  try {
    out = await run(ctx)
  } finally {
    active = false
  }
  const [answer, io] = out ?? [null, new IOResult()]
  let stdout = answer
  if (io.producer === null) {
    const stderr = await io.materializeStderr()
    return [
      stdout,
      io,
      new ExecutionNode({ command: walked.cmdStr, exitCode: io.exitCode, stderr }),
    ]
  }
  if (context.signal?.aborted === true) {
    // The caller was released at its abort, so nothing reads this output:
    // close it rather than leave its source open.
    await closeQuietly(stdout)
    await closeQuietly(io.stderr)
  }

  const prog = walked.prog
  if (walked.warnings.length > 0) {
    const warn = encodeText(walked.warnings.map((w) => `${prog}: ${w}\n`).join(''))
    const existing = await materialize(io.stderr)
    io.stderr = concat([warn, existing])
  }
  stdout = maybeWithTimeout(stdout, limit, prog)
  io.stderr = maybeWithTimeout(io.stderr, limit, prog)

  const stderrBytes = await io.materializeStderr()
  return [
    stdout,
    io,
    new ExecutionNode({
      command: walked.cmdStr,
      stderr: stderrBytes,
      exitCode: io.exitCode,
      paths: walked.paths,
    }),
  ]
}
