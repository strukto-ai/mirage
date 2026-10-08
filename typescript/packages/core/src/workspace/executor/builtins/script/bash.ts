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

import { EvaluationContext } from '../../../evaluation.ts'

import { runAsShell } from '../../../../context/session_context.ts'
import { materialize, IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { type JobConsole, JobOutput } from '../../../../shell/console/index.ts'
import type { JobTable } from '../../../../shell/job_table/index.ts'
import { parseOptionWord } from '../../../../shell/options.ts'
import { SET_OPTION_NAMES } from '../../../../shell/constants.ts'

import { ExecutionNode } from '../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { BASH_LONG_OPTIONS, BASH_START_FLAGS, BASH_UNSUPPORTED_LONG_OPTIONS } from './constants.ts'
import { readScriptFile, scriptError } from './script.ts'
import type { BashArgs } from './types.ts'
import { helpPage, versionLine } from '../../../../commands/spec/standard.ts'
import { specOf } from '../../../../commands/spec/index.ts'
import { yieldBytes } from '../../../../io/stream.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'
import { clearExitTrap, finishShell } from '../../traps.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'

function bashArgs(partial: Partial<BashArgs>): BashArgs {
  return {
    script: null,
    path: null,
    argv: [],
    settings: [],
    invalid: null,
    needsValue: null,
    help: false,
    version: false,
    ...partial,
  }
}

/**
 * Read Bash startup options, then select a program and its argv.
 *
 * GNU Bash 5.2 reads long options (one or two dashes) before short ones.
 * Help/version return after that pass: unknown long options still fail,
 * while help outranks version and unsupported modes. A long option after
 * a short one is refused as `--`. Unsupported short options name the
 * whole character here, rather than its first byte as GNU does.
 *
 * Options after a script file or `-c`'s program are positional; `-` and
 * `--` end option parsing. `-c` takes the next word, never the rest of its
 * cluster: `-cx 'echo hi'` traces and runs `echo hi`.
 */
export function parseBashArgs(args: string[]): BashArgs {
  const settings: [string, boolean][] = []
  let wantHelp = false
  let wantVersion = false
  let unsupported: string | null = null
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const spelling = args[i] ?? ''
    const spelledLong = spelling.startsWith('--') && spelling.length > 2
    const name = spelledLong ? spelling.slice(2) : spelling.slice(1)
    const takesValue = BASH_LONG_OPTIONS.get(name)
    if (takesValue === undefined) {
      if (spelledLong) return bashArgs({ invalid: spelling })
      break
    }
    if (takesValue) {
      if (i + 1 >= args.length) return bashArgs({ needsValue: name })
      i += 1
    } else if (SET_OPTION_NAMES.has(name)) {
      settings.push([name, true])
    } else if (BASH_UNSUPPORTED_LONG_OPTIONS.has(name)) {
      unsupported ??= spelling
    }
    wantHelp = wantHelp || name === 'help'
    wantVersion = wantVersion || name === 'version'
    i += 1
  }
  if (wantHelp || wantVersion) return bashArgs({ help: wantHelp, version: wantVersion })
  if (unsupported !== null) return bashArgs({ invalid: unsupported })
  let readStdin = false
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--' || tok === '-') {
      i += 1
      break
    }
    if (tok.startsWith('--')) return bashArgs({ invalid: '--' })
    const word = parseOptionWord(tok, args[i + 1] ?? null)
    if (word === null) break
    for (const ch of word.other) {
      if (!BASH_START_FLAGS.has(ch)) return bashArgs({ invalid: tok.charAt(0) + ch })
    }
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
 * A nested shell is a program of its own, so it runs on a new shell started
 * from the session's environment (`SessionState.newShell`) and leaves the
 * caller's state alone: `bash -c 'cd /x'` leaves the caller where it was,
 * and `x=1; bash -c 'echo $x'` prints an empty line, as in bash, where the
 * nested shell is a separate process. `handleSource` is the opposite case
 * and deliberately runs on the caller's session, because a sourced file is
 * the caller.
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
  if (parsed.help || parsed.version) {
    // bash answers --help ahead of --version, whatever their order, and
    // runs nothing else. The page and the version line are the ones every
    // mirage command prints, under the name typed. `sh` is this same shell,
    // so `sh --version` answers as bash invoked as sh does; Debian's dash
    // refuses it ("Illegal option --", 2).
    const text = parsed.help ? helpPage(name, specOf('bash')) : versionLine(name)
    return [
      yieldBytes(encodeText(text)),
      new IOResult(),
      new ExecutionNode({ command: name, exitCode: 0 }),
    ]
  }
  if (parsed.invalid !== null) {
    // GNU words this "invalid option" and follows it with a usage block.
    // One word covers both cases here on purpose: some of what lands here
    // is an option bash has and mirage does not implement (`-r`,
    // `--restricted`), and calling those invalid would be a lie. The exit
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
  context = new EvaluationContext(session.newShell(), context.frame.fork(), context)
  session = context.session
  clearExitTrap(session)
  session.jobOutput = new JobOutput(session.jobOutput ?? session.tty.jobs)
  session.positionalArgs = positional
  session.scriptName = scriptName
  for (const [option, enable] of parsed.settings) session.shellOptions[option] = enable
  // A nested shell is its own process, with its own jobs: its `jobs` and
  // `wait` see only them, its EXIT action's included, and they are not its
  // caller's.
  const jobs = jobTable === undefined ? {} : { jobTable: jobTable.child() }
  // A nested shell is a program of its own: the builtins it runs are its
  // builtins again, whatever `find -exec` marked the outer line.

  const io = await runAsShell(async () =>
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
