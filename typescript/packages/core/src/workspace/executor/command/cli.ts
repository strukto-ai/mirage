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

import { CLISpec, type CLIInvocation } from '../../../commands/cli/types.ts'
import { walk } from '../../../commands/cli/walk.ts'
import { HELP_OPTION } from '../../../commands/config.ts'
import { flagKwargName } from '../../../commands/spec/constants.ts'
import { renderHelp } from '../../../commands/spec/help.ts'
import { UsageError } from '../../../commands/errors.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { wordText, type PathSpec } from '../../../types.ts'
import { concatBytes } from '../../../core/jq/format.ts'
import {
  CommandTimeoutError,
  maybeWithTimeout,
  runWithTimeout,
} from '../../../commands/builtin/utils/limit.ts'
import type { CLIInstall } from '../../cli/types.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { resolveLimit } from '../../../policy/index.ts'
import { runtimeForLanguage } from '../policy/decide.ts'
import type { ScriptSource } from '../policy/types.ts'
import { runOutput, type Runtime } from '../runtime.ts'
import { optionError, parseFlags } from './flags.ts'

// argparse add_help: a leaf answers --help with its own help unless it
// declares the flag itself. CLISpec init accepts instance fields, so
// the spread is a plain init bag (the withHelpSupport pattern).
function withInjectedHelp(leaf: CLISpec): CLISpec {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return new CLISpec({ ...leaf, options: [...leaf.options, HELP_OPTION] })
}

/**
 * Pick the workspace entry that runs a script leaf.
 *
 * A `runtime:` pin names the entry, and the entry must speak the
 * script's language, so `runtime: monty` on a `.mjs` fails loud
 * instead of feeding JS to a python interpreter. Without a pin the
 * first entry speaking the language serves (runtimeForLanguage).
 * Every refusal names the world so the fix (add or rename an entry)
 * is visible.
 */
function selectRuntime(
  prog: string,
  leaf: CLISpec,
  entries: readonly Runtime[],
): [Runtime | null, string | null] {
  const script = leaf.script
  if (script === null) {
    throw new Error(`selecting a runtime for '${prog}' without a script`)
  }
  const known = entries.map((entry) => `'${entry.name}'`).join(', ') || 'none'
  if (leaf.runtime !== null) {
    const pinned = entries.find((entry) => entry.name === leaf.runtime) ?? null
    if (pinned === null) {
      return [null, `${prog}: unknown runtime: '${leaf.runtime}' (workspace runtimes: ${known})`]
    }
    if (pinned.language !== script.language) {
      return [null, `${prog}: runtime '${pinned.name}' does not run ${script.language} scripts`]
    }
    return [pinned, null]
  }
  const entry = runtimeForLanguage(entries, script.language)
  if (entry === null) {
    return [
      null,
      `${prog}: no workspace runtime runs ${script.language} scripts (workspace runtimes: ${known})`,
    ]
  }
  return [entry, null]
}

/**
 * Render the invocation onto the selected runtime as one RunArgs.
 *
 * The script tier's whole contract, the one a native binary could also
 * honor: the program re-parses `argv` (the verbatim tokens after the
 * head), reads piped stdin, and finds the install's config as
 * MIRAGE_CONFIG (JSON) in its environment. The outcome converts
 * through the interpreter handlers' one mapping (runOutput).
 */
async function scriptOutput(
  inv: CLIInvocation,
  script: ScriptSource,
  runtime: Runtime,
): Promise<[Uint8Array | null, IOResult]> {
  const env: Record<string, string> = { ...inv.env }
  if (inv.config !== null && inv.config !== undefined) {
    env.MIRAGE_CONFIG = JSON.stringify(inv.config)
  }
  const stdin = inv.stdin !== null ? await materialize(inv.stdin) : null
  const result = await runtime.run({ code: script.source, args: [...inv.argv], env, stdin })
  return runOutput(result)
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
 * (scriptOutput), so help, usage refusals, and classification all
 * happen in front of either tier. `entries` is the workspace's
 * ordered runtime world, which a script leaf selects its interpreter
 * from; empty (outside a workspace) refuses script installs.
 */
export async function handleCli(
  install: CLIInstall,
  parts: readonly (string | PathSpec)[],
  session: Session,
  stdin: ByteSource | null = null,
  entries: readonly Runtime[] = [],
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  // Words re-enter string space as typed (wordText): the walk owns
  // interpretation, so a quoted "Lunch?" must not arrive as the
  // glob-classified absolute /Lunch?. Leaf path operands are resolved
  // later by parseFlags against the session cwd.
  const words = parts.map((p) => wordText(p))
  const cmdStr = words.join(' ')
  const argv = words.slice(1)

  const result = walk(install.name, install.spec, argv)
  if (result.leaf === null) {
    const stderr = result.stream === 'stderr' ? result.output : new Uint8Array(0)
    const stdout = result.stream === 'stdout' ? result.output : null
    const io = new IOResult({ exitCode: result.exitCode, stderr })
    return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: result.exitCode, stderr })]
  }

  const prog = [install.name, ...result.path].join(' ')
  const leaf = result.leaf
  // No injected --version: that is a GNU coreutils convention, not an
  // argparse one.
  const hasHelp = leaf.options.some((option) => option.long === '--help')
  const parseSpec = hasHelp ? leaf : withInjectedHelp(leaf)

  const parsed = parseFlags([...result.argv], parseSpec, prog, session.cwd)
  const [paths, texts, flagKwargs, warnings] = [parsed[0], parsed[1], parsed[2], parsed[3]]
  if (flagKwargs.help === true) {
    const helpText = new TextEncoder().encode(renderHelp(prog, parseSpec))
    return [helpText, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }

  const refusal = optionError(
    prog,
    parsed[4],
    parsed[5],
    parsed[6],
    parsed[7],
    parsed[8],
    parsed[9],
    parsed[10],
    parsed[11],
  )
  if (refusal !== null) {
    // Leaf usage errors exit 2 (argparse), regardless of the
    // USAGE_EXIT table: prog is an installed name, never a GNU tool
    // with its own pinned exit.
    const [msg] = refusal
    return [
      null,
      new IOResult({ exitCode: 2, stderr: msg }),
      new ExecutionNode({ command: cmdStr, exitCode: 2, stderr: msg }),
    ]
  }

  // Group flags merge into the one bag: ancestor/descendant collisions
  // are a build-time CLISpec error, so a group flag can never shadow a
  // leaf flag.
  const flags: Record<string, string | boolean | number | string[]> = {}
  for (const [spelling, value] of Object.entries(result.groupFlags)) {
    flags[flagKwargName(spelling)] = value
  }
  Object.assign(flags, flagKwargs)
  delete flags.help

  const inv: CLIInvocation = {
    config: install.config,
    argv,
    paths,
    texts,
    flags,
    stdin,
    env: { ...session.env },
  }

  let body: Promise<[ByteSource | null, IOResult] | null>
  if (leaf.script !== null) {
    const [runtime, refused] = selectRuntime(prog, leaf, entries)
    if (runtime === null) {
      // The interpreter is missing, not the command: 127 like an
      // interpreter command no runtime entry captures.
      const stderr = new TextEncoder().encode(`${refused ?? ''}\n`)
      return [
        null,
        new IOResult({ exitCode: 127, stderr }),
        new ExecutionNode({ command: cmdStr, exitCode: 127, stderr }),
      ]
    }
    body = scriptOutput(inv, leaf.script, runtime)
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
    body = (async () => fn(inv))()
  }
  // The leaf's declared limit bounds the handler body and its
  // streams, exactly like mount dispatch: without the wrap a blocking
  // leaf hangs forever and an unbounded-output leaf ignores its own
  // limits.
  const limit = resolveLimit(prog, [], leaf.limit)
  const timeout = limit?.timeoutSeconds ?? null
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
      const stderr = new TextEncoder().encode(`${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: err.exitCode, stderr }),
        new ExecutionNode({ command: cmdStr, exitCode: err.exitCode, stderr }),
      ]
    }
    // A limit timeout is answered by the workspace-level handler
    // (exit 124), not here.
    if (err instanceof CommandTimeoutError) throw err
    // Any other thrown leaf error (an API error, a TypeError) becomes
    // this command's IOResult, prefixed like GNU (prog: message), so
    // the rest of the line keeps running.
    const message = err instanceof Error ? err.message : String(err)
    const stderr = new TextEncoder().encode(`${prog}: ${message}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr }),
    ]
  }
  io.producer = { command: prog, prefixes: [], declared: leaf.limit ?? null }

  if (warnings.length > 0) {
    const warn = new TextEncoder().encode(warnings.map((w) => `${prog}: ${w}\n`).join(''))
    const existing = await materialize(io.stderr)
    io.stderr = concatBytes([warn, existing])
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
