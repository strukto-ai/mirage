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

import { leafRefusal } from '../../../commands/cli/refusal.ts'
import type { CommandDispatch } from '../../../commands/config.ts'
import type { MountRoot, StatPath } from '../../../ops/types.ts'
import { CLISpec } from '../../../commands/cli/types.ts'
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
import { optionError, parseFlags } from './flags.ts'

// argparse add_help: a leaf answers --help with its own help unless it
// declares the flag itself. CLISpec init accepts instance fields, so
// the spread is a plain init bag (the withHelpSupport pattern).
function withInjectedHelp(leaf: CLISpec): CLISpec {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return new CLISpec({ ...leaf, options: [...leaf.options, HELP_OPTION] })
}

/**
 * Workspace facts the dispatcher can offer but most CLIs do not want: an API
 * client needs no filesystem, while `git` is nothing but one. Forwarded whole
 * onto the leaf's opts bag, so a leaf that does not read them ignores them and
 * there is no allowlist of filesystem-aware CLIs to keep in step (the same rule
 * `links` follows for mount commands).
 */
export interface CliFacts {
  dispatch?: CommandDispatch
  statPath?: StatPath
  mountRoot?: MountRoot
}

/**
 * Execute a line whose head word is an installed CLI.
 *
 * Dispatch is by NAME: the install resolves the program tree and the
 * validated config; no mount is consulted and no operand path picks a
 * backend (the one executor divergence from mount commands). The walk
 * consumes subcommand words and group options; the leaf's own argv
 * rides the ordinary spec machinery because a CLISpec IS a
 * CommandSpec, and the leaf handler runs as
 * `fn(config, paths, texts, opts)` with the installation's config in
 * the accessor's seat.
 */
export async function handleCli(
  install: CLIInstall,
  parts: readonly (string | PathSpec)[],
  session: Session,
  stdin: ByteSource | null = null,
  facts: CliFacts = {},
  dropCaches: (() => Promise<void>) | null = null,
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  // Words re-enter string space as typed (wordText): the walk owns
  // interpretation, so a quoted "Lunch?" must not arrive as the
  // glob-classified absolute /Lunch?. Leaf path operands are resolved
  // later by parseFlags against the session cwd.
  const words = parts.map((p) => wordText(p))
  const cmdStr = words.join(' ')
  const argv = words.slice(1)

  const result = walk(install.name, install.spec, argv, session.cwd)
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
    // The dialect is the root's, not the leaf's: a program answers in one
    // voice at every level.
    const [msg, code] = leafRefusal(install.spec.usageStyle, refusal[0], parsed[4])
    return [
      null,
      new IOResult({ exitCode: code, stderr: msg }),
      new ExecutionNode({ command: cmdStr, exitCode: code, stderr: msg }),
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

  const fn = leaf.fn
  if (fn === null) {
    // validateCli guarantees fn XOR subcommands and walk only returns
    // fn-bearing nodes as leaf; reaching this is a bug.
    throw new Error(`walk returned a leaf without fn for '${prog}'`)
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
    const out = await runWithTimeout(
      Promise.resolve(fn(install.config, paths, texts, { stdin, flags, ...facts })),
      timeout,
      prog,
    )
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
  // An account CLI mutates its service by id, so no vfs path can be derived
  // from the call and per-path invalidation has nothing to aim at: a newly
  // created file has no cache entry to expire, which is the case that
  // matters. Dropping the service's listings is what lets the agent's next
  // `ls` see what it just made, and dropping its cached bodies is what lets
  // the next `cat` see an edit rather than the pre-write content.
  if (leaf.write && dropCaches !== null) await dropCaches()
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
