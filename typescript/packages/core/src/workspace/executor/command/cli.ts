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
  directoryRefusal,
  clapMissingOperands,
  leafRefusal,
} from '../../../commands/cli/refusal.ts'
import { missCondition } from '../../mount/namespace/probe.ts'
import { FileType, wordText, PathSpec, type Limit } from '../../../types.ts'
import { flagOccurrences } from '../../../commands/spec/flag_view.ts'
import type { ProcessView } from '../../../process/view.ts'
import { CLAP_EXIT, CLI_CONFIG_ENV, GIT_LONG_OPTIONS } from '../../../commands/cli/constants.ts'
import { CLISpec, type CLIInvocation, type CLIView } from '../../../commands/cli/types.ts'
import { listedNode, nodeHelp, ownsArgv, walk } from '../../../commands/cli/walk.ts'
import { verbVisible } from '../../lookup/lookup.ts'
import { type DispatchFn, type RunResult, type ScriptSource } from '../../../runtime/types.ts'
import type { NamespaceView, SessionView, StatPath } from '../../../view/types.ts'
import { flagKwargName } from '../../../commands/spec/constants.ts'
import { UsageStyle, Operand, type FlagValue } from '../../../commands/spec/types.ts'
import { PartialOutputError, UsageError } from '../../../commands/errors.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { maybeWithTimeout, runWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import type { CLIInstall } from '../../cli/types.ts'
import type { SessionState } from '../../session/session.ts'
import { envSnapshot } from '../../session/state.ts'
import { ExecutionNode } from '../../types.ts'
import { resolveLimit } from '../../../policy/index.ts'
import { runtimeForLanguage } from '../../../runtime/routing/decide.ts'
import type { RouteDecision } from '../../../runtime/routing/index.ts'
import { admissionDenial } from './run.ts'
import { runOutput, runtimeUnavailable } from '../../../commands/builtin/general/interpreter.ts'
import type { Runtime } from '../../../runtime/base.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { WorkspaceRuntime } from '../../../runtime/workspace.ts'
import { optionError, parseFlags } from './flags.ts'
import { concat } from '../../../io/cachable_iterator.ts'
import { encodeText } from '../../../shell/bytes.ts'

// A textual rest operand is a CLI node's pass-through form: parsed under
// unknownIsOperand, it takes the undeclared dashed tokens the node does not
// refuse, which is what a program parsing its own argv needs. 'str', not
// 'path', so nothing is cwd-resolved or routed. Only that parse reads the
// rest kind this way: a GNU command's textual rest is a list of operands,
// which is why basename has one and still refuses an option it does not know.
const PASSTHROUGH_REST = new Operand({ type: 'str' })

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
 * is mirage's to answer. CLISpec init accepts instance fields, so each
 * spread is a plain init bag (the withHelpSupport pattern).
 */
function parseSpecFor(leaf: CLISpec, style: UsageStyle = UsageStyle.ARGPARSE): [CLISpec, boolean] {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  if (ownsArgv(leaf)) return [new CLISpec({ ...leaf, rest: PASSTHROUGH_REST }), false]
  if (leaf.options.some((option) => option.long === '--help')) return [leaf, false]
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [new CLISpec({ ...leaf, options: listedNode(leaf, style).options }), true]
}

/**
 * Pick the workspace entry that runs a script leaf.
 *
 * A `runtime:` pin names the entry, and the entry must speak the
 * script's language, so `runtime: monty` on a `.mjs` fails loud
 * instead of feeding JS to a python interpreter. Without a pin the
 * program runs where this line runs its language's own interpreter
 * (the tier's head word, `python3` or `node`), so a route policy or a
 * runtime's script places it as it places that command, and a line
 * every capturer refused is refused here too (126). The first entry
 * speaking the language serves when there is no line decision or the
 * workspace serves that interpreter itself (runtimeForLanguage); a
 * placement on a runtime that does not run the script's language is
 * refused like such a pin. Every other refusal names the world so the
 * fix (add or rename an entry) is visible (127). Mirrors Python's
 * `_select_runtime`.
 */
function selectRuntime(
  prog: string,
  leaf: CLISpec,
  entries: readonly Runtime[],
  routing?: RouteDecision,
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
 * Render the invocation onto the selected runtime as one RunArgs.
 *
 * The script tier's whole contract, the one a native binary could also
 * honor: the program is named (argv slot 0, so its own messages read
 * `pager:` and a renamed install names itself), re-parses `argv` (the
 * verbatim tokens after the head), reads piped stdin, and finds the
 * install's config as `MIRAGE_CLI_CONFIG` (JSON) in its environment.
 * The outcome converts through the interpreter handlers' one mapping
 * (runOutput). `prog` is the installed head word.
 */
async function scriptOutput(
  inv: CLIInvocation,
  script: ScriptSource,
  runtime: LanguageRuntime,
  prog: string,
  timeout: number | null,
  signal: AbortSignal,
): Promise<[Uint8Array | null, IOResult]> {
  const env: Record<string, string> = { ...inv.env }
  if (inv.config !== null && inv.config !== undefined) {
    env[CLI_CONFIG_ENV] = JSON.stringify(inv.config)
  }
  const stdin = inv.stdin !== null ? await materialize(inv.stdin) : null
  let result: RunResult
  try {
    // A .mjs source needs the engine's module mode, the same bit the js
    // command derives from the operand's extension.
    result = await runtime.execute({
      kind: 'code',
      language: runtime.language,
      code: script.source,
      args: [...inv.argv],
      prog,
      scriptCli: true,
      cwd: inv.cwd,
      env,
      stdin,
      signal,
      ...(timeout !== null && timeout > 0 ? { timeoutSeconds: timeout } : {}),
      ...(script.module ? { flags: { module: true } } : {}),
    })
  } catch (err) {
    // The interpreter is missing, not the program: 127, as the
    // interpreter command answers for the same runtime.
    if (!runtimeUnavailable(err)) throw err
    return [null, missing(`${prog}: ${err.message}`)]
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
  shell?: (command: string) => Promise<IOResult>
  signal?: AbortSignal
  commandLimits?: Readonly<Record<string, Limit>>
  /**
   * The workspace's ordered runtime world, which a script leaf selects
   * its interpreter from; absent (outside a workspace) refuses script
   * installs.
   */
  entries?: readonly Runtime[]
  dispatch?: DispatchFn
  statPath?: StatPath
  ns?: NamespaceView
  sessionView?: SessionView
  processes?: ProcessView
  /** The line's placement, which a script leaf runs its program under. */
  routing?: RouteDecision
}

/**
 * Whether a write verb of this CLI leaves every mount's caches stale.
 *
 * A CLI that reaches a service writes past the dispatcher's per-path
 * invalidation, so no mount can see the write. Two roots do that: one with a
 * `configModel` (an account CLI, initialized from it) and a script root, whose
 * config is opaque by construction and whose program may reach anything. A
 * root with neither (`git`) has no service to reach; its writes go through the
 * dispatcher, which invalidates as it goes, so a blanket drop would only cost
 * every other mount a reload.
 */
export function dropsMountCaches(spec: CLISpec): boolean {
  return spec.configModel !== null || spec.script !== null
}

/**
 * Execute a line whose head word is an installed CLI.
 *
 * Dispatch is by NAME: the install resolves the program tree and the
 * validated config; no mount is consulted and no operand path picks a
 * backend (the one executor divergence from mount commands). The walk
 * consumes subcommand words and group options; the leaf's own argv
 * rides the ordinary spec machinery because a CLISpec IS a
 * CommandSpec. The leaf handler renders the line's one CLIInvocation,
 * built here and nowhere else: an fn leaf runs as `fn(inv)`, a script
 * leaf runs its embedded program on a workspace runtime
 * (scriptOutput), so usage refusals, limits, and classification all
 * happen in front of either tier. Help too, for every node that declared
 * a grammar to render it from (parseSpecFor). The workspace facts in
 * `context` reach a verb as one `inv.view` field, one entry point per state
 * plane, so a verb that never reads it cannot touch a mount.
 */
export async function handleCli(
  install: CLIInstall,
  parts: readonly (string | PathSpec)[],
  session: SessionState,
  stdin: ByteSource | null = null,
  context: CLIContext = {},
  dropCaches: (() => Promise<void>) | null = null,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  // Words re-enter string space as typed (wordText): the walk owns
  // interpretation, so a quoted "Lunch?" must not arrive as the
  // glob-classified absolute /Lunch?. Leaf path operands are resolved
  // later by parseFlags against the session cwd.
  const words = parts.map((p) => wordText(p))
  const cmdStr = words.join(' ')
  const argv = words.slice(1)

  // The walk takes the same environment the leaf parse below does, so
  // a group-level option declaring `Option.env` fills at its own
  // level; without it the fetched credential never enters groupFlags.
  const result = walk(install.name, install.spec, argv, session.cwd, envSnapshot(session), (path) =>
    verbVisible(install.name, path, session),
  )
  if (result.leaf === null) {
    const stderr = result.stream === 'stderr' ? result.output : new Uint8Array(0)
    const stdout = result.stream === 'stdout' ? result.output : null
    const io = new IOResult({ exitCode: result.exitCode, stderr })
    return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: result.exitCode, stderr })]
  }

  if (context.statPath !== undefined && context.dispatch !== undefined) {
    for (const base of result.operandBases) {
      const info = await context.statPath(base)
      if (info !== null && info.type === FileType.DIRECTORY) continue
      const reason = info === null ? await missCondition(context.dispatch, base) : 'ENOTDIR'
      const [stderr, code] = directoryRefusal(
        install.name,
        base.rawPath,
        reason,
        install.spec.usageStyle,
      )
      return [
        null,
        new IOResult({ exitCode: code, stderr }),
        new ExecutionNode({ command: cmdStr, exitCode: code, stderr }),
      ]
    }
  }

  const prog = [install.name, ...result.path].join(' ')
  const leaf = result.leaf
  // No injected --version: that is a GNU coreutils convention, not an
  // argparse one.
  const [parseSpec, mirageHelp] = parseSpecFor(leaf, install.spec.usageStyle)

  // The dialect is the root's, not the leaf's: a program answers in one voice
  // at every level.
  const style = install.spec.usageStyle
  // The environment goes into the parse, not on top of it: an option
  // declaring one is coerced, choice-checked, path-resolved and credited
  // against required exactly as a typed value is.
  // git resolves an abbreviated long option against the verb's own full table
  // (parse-options), and its revision walkers take whole words only.
  const abbreviations =
    install.spec.name === 'git' ? (GIT_LONG_OPTIONS.get(result.path.join(' ')) ?? []) : undefined
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
    // Only clap names the empty slots. Under every other style a required
    // operand stays the leaf's own business, worded by the command, which is
    // what every mirage CLI did before this.
    msg = clapMissingOperands(
      prog,
      parseSpec,
      parsed.missingRequiredOperands,
      parsed.typedDests,
      session.env,
    )
    code = CLAP_EXIT
  }
  if (msg !== null) {
    return [
      shown,
      new IOResult({ exitCode: code, stderr: msg.length > 0 ? msg : null }),
      new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
    ]
  }

  // Group flags merge into the one bag: ancestor/descendant collisions
  // are a build-time CLISpec error, so a group flag can never shadow a
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

  // The workspace entry points a mount-reading verb needs ride the record as one
  // field. Most CLIs never read it: an API client has no filesystem,
  // while `git` is nothing but one. Absent outside a workspace, so a verb
  // that needs a mount refuses there on its own.
  const view: CLIView = {
    ...(context.processes === undefined ? {} : { processes: context.processes }),
    ...(context.dispatch !== undefined ? { dispatch: context.dispatch } : {}),
    ...(context.statPath !== undefined ? { statPath: context.statPath } : {}),
    ...(context.ns !== undefined ? { ns: context.ns } : {}),
    ...(context.sessionView !== undefined ? { sessionView: context.sessionView } : {}),
  }
  let active = true
  const shell = async (command: string): Promise<IOResult> => {
    if (!active || context.signal?.aborted === true) {
      throw new Error('CLI shell is no longer active')
    }
    if (context.shell === undefined) throw new Error('CLI shell is unavailable')
    return context.shell(command)
  }
  const inv: CLIInvocation = {
    config: install.config,
    ...(context.shell !== undefined ? { shell } : {}),
    argv,
    paths,
    texts,
    cwd: PathSpec.fromStrPath(session.cwd),
    flags,
    stdin,
    env: envSnapshot(session),
    ...(Object.keys(view).length > 0 ? { view } : {}),
    spec: leaf,
  }

  // The outer timer bounds the whole invocation; the runtime deadline
  // also interrupts engines that block their event loop. Unlike Python's
  // asyncio cancellation, racing a promise does not stop its work.
  const limit = resolveLimit(
    prog,
    [],
    leaf.limit,
    null,
    context.commandLimits,
    session.commandLimits,
  )
  const timeout = limit?.timeoutSeconds ?? null
  const abort = new AbortController()
  let body: Promise<[ByteSource | null, IOResult] | null>
  if (leaf.script !== null) {
    const [runtime, refused] = selectRuntime(prog, leaf, context.entries ?? [], context.routing)
    if (runtime === null) {
      // The interpreter is missing, not the command: 127 like an
      // interpreter command no runtime entry captures, or 126 when this
      // line's capturers all refused it.
      const stderr = await materialize(refused.stderr)
      return [
        null,
        new IOResult({ exitCode: refused.exitCode, stderr }),
        new ExecutionNode({ command: cmdStr, exitCode: refused.exitCode, stderr }),
      ]
    }
    body = scriptOutput(inv, leaf.script, runtime, prog, timeout, abort.signal)
  } else {
    const fn = leaf.fn
    if (fn === null) {
      // validateCli guarantees fn XOR subcommands XOR script and walk
      // only returns handler-bearing nodes as leaf; reaching this is a
      // bug.
      throw new Error(`walk returned a leaf without a handler for '${prog}'`)
    }
    // Defer the call into the promise: a synchronously-thrown leaf
    // error must land in the catch arms below, exactly as when the
    // call sat inside the try.
    body = Promise.resolve().then(() => fn(inv))
  }
  // The leaf's declared limit bounds the handler body and its
  // streams, exactly like mount dispatch: without the wrap a blocking
  // leaf hangs forever and an unbounded-output leaf ignores its own
  // limits.
  let stdout: ByteSource | null = null
  let io = new IOResult()
  try {
    const out = await runWithTimeout(body, timeout, prog)
    if (out !== null) {
      ;[stdout, io] = out
    }
  } catch (err) {
    // Leaf-raised usage errors (a malformed --json) keep the bare
    // message and exit 2, matching the refusal branch above.
    if (err instanceof UsageError) {
      const stderr = encodeText(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: err.exitCode, stderr }),
        new ExecutionNode({ command: cmdStr, exitCode: err.exitCode, stderr }),
      ]
    }
    // A limit timeout is answered by the workspace-level handler
    // (exit 124), not here.
    if (err instanceof CommandTimeoutError) {
      abort.abort()
      // Racing a promise does not stop its work: a typed fn that ignores
      // the abort signal keeps running, and its request may land after
      // exit 124. Drop now, for a write the service already accepted, and
      // again when the body settles, for one still in flight.
      if (leaf.write && dropCaches !== null) {
        await dropCaches()
        const settle = (): Promise<void> => dropCaches()
        void body.then(settle, settle).catch((dropErr: unknown) => {
          // The command already returned, so a drop that fails here (a
          // workspace torn down under it) has no stream to land on; it
          // is reported rather than left as an unhandled rejection.
          const reason = dropErr instanceof Error ? dropErr.message : String(dropErr)
          console.warn(`${prog}: cache drop after timeout failed: ${reason}`)
        })
      }
      throw err
    }
    // Any other thrown leaf error (an API error, a TypeError) becomes
    // this command's IOResult, prefixed like GNU (prog: message), so
    // the rest of the line keeps running, and what a leaf printed before
    // it failed stays printed.
    // The write may already have landed when a leaf throws after its
    // request (a PUT whose --jq program fails filters a response the
    // service already applied); without the drop a github mount keeps
    // serving its pre-write bytes.
    if (leaf.write && dropCaches !== null) await dropCaches()
    const message = err instanceof Error ? err.message : String(err)
    const stderr = encodeText(`${prog}: ${message}\n`)
    return [
      err instanceof PartialOutputError ? err.stdout : null,
      new IOResult({ exitCode: 1, stderr }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr }),
    ]
  } finally {
    active = false
  }
  // The spec's `write` is the one answer: what policy calls a write, the
  // cache does too, so a verb that can mutate (`gh api` under any method)
  // costs the mounts a reload rather than a stale read.
  if (leaf.write && dropCaches !== null) await dropCaches()

  io.producer = { command: prog, prefixes: [], declared: leaf.limit ?? null }

  if (warnings.length > 0) {
    const warn = encodeText(warnings.map((w) => `${prog}: ${w}\n`).join(''))
    const existing = await materialize(io.stderr)
    io.stderr = concat([warn, existing])
  }

  stdout = maybeWithTimeout(stdout, limit, prog)
  io.stderr = maybeWithTimeout(io.stderr, limit, prog)

  const stderrBytes = await materialize(io.stderr)
  return [
    stdout,
    io,
    new ExecutionNode({ command: cmdStr, stderr: stderrBytes, exitCode: io.exitCode, paths }),
  ]
}
