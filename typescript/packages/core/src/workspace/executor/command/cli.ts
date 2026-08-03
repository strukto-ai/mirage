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

import { CLISpec } from '../../../commands/cli/types.ts'
import { walk } from '../../../commands/cli/walk.ts'
import { HELP_OPTION } from '../../../commands/config.ts'
import { flagKwargName } from '../../../commands/spec/constants.ts'
import { renderHelp } from '../../../commands/spec/help.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { concatBytes } from '../../../core/jq/format.ts'
import { maybeWithTimeout, runWithTimeout } from '../../../commands/builtin/utils/limit.ts'
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
): Promise<[ByteSource | null, IOResult, ExecutionNode]> {
  const words = parts.map((p) => (p instanceof PathSpec ? p.virtual : p))
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
  const out = await runWithTimeout(
    Promise.resolve(fn(install.config, paths, texts, { stdin, flags })),
    timeout,
    prog,
  )
  let stdout: ByteSource | null = null
  let io = new IOResult()
  if (out !== null) {
    ;[stdout, io] = out
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
