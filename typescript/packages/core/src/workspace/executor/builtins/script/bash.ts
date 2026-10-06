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

import { type EvaluationContext, childContext } from '../../../evaluation.ts'
import { releaseFunctions } from '../../../session/functions.ts'

import { runAsShell } from '../../../../context/session_context.ts'
import { materialize, IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { type JobConsole, JobOutput } from '../../../../shell/console/index.ts'
import { IFS_DEFAULT } from '../../../../shell/constants.ts'
import type { JobTable } from '../../../../shell/job_table/index.ts'
import { parseOptionWord } from '../../../../shell/options.ts'

import { seedVar } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { BASH_LONG_OPTIONS, BASH_START_FLAGS } from './constants.ts'
import { readScriptFile, scriptError } from './script.ts'
import type { BashArgs } from './types.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'
import { clearExitTrap, finishShell } from '../../traps.ts'
import { decodeText } from '../../../../shell/bytes.ts'

function bashArgs(partial: Partial<BashArgs>): BashArgs {
  return {
    script: null,
    path: null,
    argv: [],
    settings: [],
    invalid: null,
    needsValue: null,
    ...partial,
  }
}

/**
 * Split a `bash`/`sh` argument list into flags, program and argv.
 *
 * Option parsing stops at the first operand, so everything after a script
 * file (or after `-c`'s program text) is positional, even when it looks
 * like a flag: `bash run.sh -c foo` passes `-c foo` to the script. `-` and
 * `--` both end it without being operands.
 *
 * `-c` takes the next *word*, never the rest of its cluster, which is where
 * bash's own parser departs from getopt: `bash -cx 'echo hi'` traces and
 * runs `echo hi` rather than running `x`.
 *
 * The two failure fields report what went wrong rather than a rendered
 * message, the way `ShellParse` does: the wording and the exit code belong
 * to the caller, which is the only thing that knows the head word the shell
 * was spelled as.
 */
export function parseBashArgs(args: string[]): BashArgs {
  const settings: [string, boolean][] = []
  let readStdin = false
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--' || tok === '-') {
      i += 1
      break
    }
    if (tok.startsWith('--')) {
      const takesValue = BASH_LONG_OPTIONS[tok]
      if (takesValue === undefined) return bashArgs({ invalid: tok })
      i += takesValue ? 2 : 1
      continue
    }
    const word = parseOptionWord(tok, args[i + 1] ?? null)
    if (word === null) break
    let known = true
    for (let j = 0; j < word.other.length; j++) {
      if (!BASH_START_FLAGS.has(word.other.charAt(j))) {
        known = false
        break
      }
    }
    if (!known) return bashArgs({ invalid: tok })
    settings.push(...word.settings)
    readStdin = readStdin || word.other.includes('s')
    if (word.other.includes('c')) {
      const next = args[i + word.consumed]
      if (next === undefined) return bashArgs({ needsValue: '-c' })
      return bashArgs({ script: next, argv: args.slice(i + word.consumed + 1), settings })
    }
    i += word.consumed
  }
  // The program comes from stdin whenever no operand names one, which is
  // the rule `-s` states explicitly for the case where operands do follow:
  // `bash -s A B` reads stdin and makes A and B positional.
  if (i < args.length && !readStdin) {
    return bashArgs({ path: args[i] ?? '', argv: args.slice(i + 1), settings })
  }
  return bashArgs({ argv: args.slice(i), settings })
}

/**
 * Run a nested shell: inline text from `-c`, or a script file.
 *
 * `name` is the head word (`bash` or `sh`). bash reports itself by
 * `argv[0]`, so the diagnostics follow the spelling the caller used.
 *
 * A nested shell is a child shell, so it runs on a subshell of the session
 * and leaves the caller's state alone: `bash -c 'cd /x'` leaves the caller
 * where it was, as it does in bash, where the nested shell is a separate
 * process. `handleSource` is the opposite case and deliberately runs on the
 * caller's session, because a sourced file is the caller.
 */
export async function handleBash(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  args: string[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  name = 'bash',
  sink?: JobConsole,
  jobTable?: JobTable,
): Promise<Result> {
  let session = context.session
  const parsed = parseBashArgs(args)
  if (parsed.invalid !== null) {
    // GNU words this "invalid option" and follows it with a usage block.
    // One word covers both cases here on purpose: some of what lands here
    // is an option bash has and mirage does not implement (`-r`, `-a`,
    // `--version`), and calling those invalid would be a lie. The exit
    // status is GNU's 2 either way.
    return scriptError(name, `${parsed.invalid}: unsupported option`, 2)
  }
  if (parsed.needsValue !== null) {
    return scriptError(name, `${parsed.needsValue}: option requires an argument`, 2)
  }
  let script = parsed.script
  let scriptName = script !== null && parsed.argv.length > 0 ? (parsed.argv[0] ?? name) : name
  const positional = script !== null ? parsed.argv.slice(1) : parsed.argv
  if (script === null && parsed.path !== null) {
    scriptName = parsed.path
    const [text, failure] = await readScriptFile(dispatch, name, parsed.path, session)
    if (failure !== null) return failure
    script = text
  }
  if (script === null && stdin !== null) {
    const data = await materialize(stdin)
    if (data.length > 0) {
      script = decodeText(data)
      stdin = null
    }
  }
  if (script === null) {
    return [null, new IOResult(), new ExecutionNode({ command: name, exitCode: 0 })]
  }
  context = childContext(context)
  session = context.session
  clearExitTrap(session)
  session.jobOutput = new JobOutput(session.jobOutput ?? session.tty.jobs)
  session.positionalArgs = positional
  session.scriptName = scriptName
  // bash starts every shell with the default IFS and never reads one from
  // its environment, so `IFS=, bash -c ...` splits on blanks.
  seedVar(session, 'IFS', IFS_DEFAULT)
  // A child shell is outside every function and `source` its caller is
  // inside: it runs on a call stack of its own, and `FUNCNAME` is empty.
  session.functionNames = []
  session.localVars = null
  session.localFrames = []
  session.localRandom = []
  for (const [option, enable] of parsed.settings) session.shellOptions[option] = enable
  // A nested shell is its own process, with its own jobs: its `jobs` and
  // `wait` see only them, its EXIT action's included, and they are not its
  // caller's.
  const jobs = jobTable === undefined ? {} : { jobTable: jobTable.child() }
  let io
  // A nested shell is a program of its own: the builtins it runs are its
  // builtins again, whatever `find -exec` marked the outer line.
  try {
    io = await runAsShell(async () =>
      finishShell(
        (action, opts) => executeFn(action, { ...opts, ...jobs, context }),
        session,
        await executeFn(script, {
          context,
          sessionId: session.sessionId,
          stdin,
          ...(sink === undefined ? {} : { sink }),
          ...jobs,
        }),
        stdin,
      ),
    )
  } finally {
    releaseFunctions(session.functions)
  }
  const label = parsed.path !== null ? `${name} ${parsed.path}` : `${name} -c ${script}`
  return [io.stdout, io, new ExecutionNode({ command: label, exitCode: io.exitCode })]
}

/** The `bash` / `sh` arm; the head word names the nested shell. */
export async function bashBuiltin(call: BuiltinCall): Promise<Result> {
  return handleBash(
    call.dispatch,
    call.executeFn,
    [...call.argv.args],
    call.context,
    call.stdin,
    call.argv.name,
    call.sink,
    call.jobTable,
  )
}
