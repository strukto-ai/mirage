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

import { resolvePath } from '../../../utils/path.ts'
import { materialize, IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import { parseOptionWord } from '../../../shell/options.ts'
import { FileType } from '../../../types.ts'
import type { PathSpec } from '../../../types.ts'
import { eisdir, fsStrerror } from '../../../utils/errors.ts'
import type { Session } from '../../session/session.ts'
import { sleep } from '../../abort.ts'
import { ExecutionNode } from '../../types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { resolvePathStat } from './links.ts'
import { toScope, scopePath } from './scope.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

export async function handleEval(
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
): Promise<Result> {
  const script = args.join(' ')
  const io = await executeFn(script, { sessionId: session.sessionId })
  return [io.stdout, io, new ExecutionNode({ command: 'eval', exitCode: io.exitCode })]
}

// Startup letters bash has that `set` does not. `c` takes the program text
// from the next word and `s` reads it from stdin; the rest have nothing to
// configure in an embedded shell, which has no login profile, no rc file and
// no tty. Letters that name a `set` option (-e -u -x -f) are not here:
// parseOptionWord already knows them, so the two spellings cannot drift.
const BASH_START_FLAGS = new Set(['c', 's', 'l', 'i'])

// bash's long options, mapped to whether the option takes the next word. A
// flat set of names to ignore cannot say that `--rcfile FILE` swallows FILE,
// and read `bash --rcfile run.sh` as "run run.sh". Anything absent is refused
// rather than mistaken for a script operand, which is what made
// `bash --version` report a missing file.
const BASH_LONG_OPTIONS: Readonly<Record<string, boolean>> = Object.freeze({
  '--login': false,
  '--noediting': false,
  '--noprofile': false,
  '--norc': false,
  '--posix': false,
  '--init-file': true,
  '--rcfile': true,
})

// GNU prints the refusal and the usage line together, both under the
// builtin's own name, and exits 2 without ending the script.
const SOURCE_USAGE = 'filename argument required\nsource: usage: source filename [arguments]'

/**
 * A diagnostic from a shell that never got as far as running.
 *
 * `prefix` and `command` come apart because bash reports itself by
 * `argv[0]`, which for a script operand is the operand: the recorded
 * command still has to be the builtin that ran, not a file path.
 */
function scriptError(prefix: string, message: string, code: number, command?: string): Result {
  const err = new TextEncoder().encode(`${prefix}: ${message}\n`)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: command ?? prefix, exitCode: code, stderr: err }),
  ]
}

export interface BashArgs {
  // Inline program text from `-c`.
  script: string | null
  // Script file operand, as typed.
  path: string | null
  // Words after the program: `$0` first for the `-c` form, all
  // positional for the other two.
  argv: string[]
  // Shell options the startup flags turn on or off, in the order written.
  settings: [string, boolean][]
  // The option word the shell does not have.
  invalid: string | null
  // The option given no argument.
  needsValue: string | null
}

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
 * Read a script file through the op dispatcher.
 *
 * Every way of running a script off a mount comes through here, so a backend
 * quirk is answered once rather than per caller. The one answered today is a
 * directory: a keyed backend has no directory object to open, so it reports a
 * read of one as ENOENT where a real filesystem reports EISDIR. The stat
 * probe that tells the two apart runs only on the failure path, and asks both
 * channels a backend can answer on, since on a prefix store a directory is
 * the set of keys under it rather than an object.
 *
 * The caller owns the diagnostic: `source` and a nested shell word the same
 * failure differently and exit differently on it.
 */
async function readScriptText(dispatch: DispatchFn, path: string, cwd: string): Promise<string> {
  const scope = toScope(resolvePath(path, cwd))
  let data: unknown
  try {
    ;[data] = await dispatch('read', scope)
  } catch (exc) {
    if ((exc as { code?: string }).code !== 'ENOENT') throw exc
    const stat = await resolvePathStat(dispatch, scope)
    if (stat !== null && stat.type === FileType.DIRECTORY) throw eisdir(path)
    throw exc
  }
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data === null || data === undefined) return ''
  return new TextDecoder().decode(await materialize(data as ByteSource))
}

/**
 * Read a script file operand, or the failure bash reports for it.
 *
 * GNU splits the diagnostics by how far startup got, and both halves fall out
 * of the errno rather than being listed case by case. A file the shell cannot
 * open at all is blamed on the shell, and only a missing one is exit 127
 * (`bash: run.sh: No such file or directory`); anything it found but could not
 * run is 126 (`Permission denied`, `Not a directory`). A directory is the
 * exception, because it opens fine and fails on the first read, by which point
 * `$0` is already the operand, so bash prints it twice (`/tmp: /tmp: Is a
 * directory`, exit 126). Reproduced rather than tidied up: it is what an agent
 * copying a message into a search box will find.
 */
async function readScriptFile(
  dispatch: DispatchFn,
  name: string,
  path: string,
  session: Session,
): Promise<[string, null] | [null, Result]> {
  try {
    return [await readScriptText(dispatch, path, session.cwd), null]
  } catch (exc) {
    // A strerror is exactly what makes this a filesystem error, so the
    // lookup is both the test and the message.
    const strerror = fsStrerror(exc)
    if (strerror === null) throw exc
    const code = (exc as { code?: string }).code
    if (code === 'EISDIR') {
      return [null, scriptError(path, `${path}: ${strerror}`, 126, name)]
    }
    return [null, scriptError(name, `${path}: ${strerror}`, code === 'ENOENT' ? 127 : 126)]
  }
}

/**
 * Run a nested shell: inline text from `-c`, or a script file.
 *
 * `name` is the head word (`bash` or `sh`). bash reports itself by
 * `argv[0]`, so the diagnostics follow the spelling the caller used.
 *
 * A nested shell is a child shell, so it runs on a snapshot of the session
 * and the caller gets its state back afterwards: `bash -c 'cd /x'` leaves the
 * caller where it was, as it does in bash, where the nested shell is a
 * separate process. `handleSource` is the opposite case and deliberately does
 * not snapshot, because a sourced file is the caller.
 */
export async function handleBash(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
  stdin: ByteSource | null = null,
  name = 'bash',
): Promise<Result> {
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
      script = new TextDecoder().decode(data)
      stdin = null
    }
  }
  if (script === null) {
    return [null, new IOResult(), new ExecutionNode({ command: name, exitCode: 0 })]
  }
  const saved = session.snapshot()
  session.positionalArgs = positional
  session.scriptName = scriptName
  // A child shell is outside every `source` its caller is inside, so a
  // top-level `return` in the script it runs is the error bash reports
  // rather than an early exit the program loop absorbs.
  session.sourceDepth = 0
  for (const [option, enable] of parsed.settings) session.shellOptions[option] = enable
  let io
  try {
    io = await executeFn(script, { sessionId: session.sessionId, stdin })
  } finally {
    session.restore(saved)
  }
  const label = parsed.path !== null ? `${name} ${parsed.path}` : `${name} -c ${script}`
  return [io.stdout, io, new ExecutionNode({ command: label, exitCode: io.exitCode })]
}

export async function handleSource(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  path: string | PathSpec,
  session: Session,
  args: string[] = [],
): Promise<Result> {
  const raw = scopePath(path)
  if (raw === '') return scriptError('source', SOURCE_USAGE, 2)
  let script: string
  try {
    script = await readScriptText(dispatch, raw, session.cwd)
  } catch (err) {
    const strerror = fsStrerror(err)
    if (strerror === null) throw err
    return scriptError('source', `${raw}: ${strerror}`, 1, `source ${raw}`)
  }
  let savedPositional: string[] | null = null
  if (args.length > 0) {
    savedPositional = session.positionalArgs
    session.positionalArgs = args
  }
  session.sourceDepth += 1
  try {
    const io = await executeFn(script, { sessionId: session.sessionId })
    return [io.stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
  } finally {
    session.sourceDepth -= 1
    if (savedPositional !== null) session.positionalArgs = savedPositional
  }
}

// Finite non-negative decimals only ("0", "0.2", ".5", "1.", "+1", "1e-3").
// GNU sleep additionally accepts "inf" and sleeps forever; an agent shell
// must never hang, so non-finite intervals are rejected (deliberate
// divergence). The regex also keeps Python/TypeScript parsing identical:
// Number() alone would accept "0x10", "Infinity", and the empty string that
// float() rejects, and float() accepts "inf", "nan", and "1_0".
const SLEEP_INTERVAL = /^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

export async function handleSleep(args: string[], signal?: AbortSignal): Promise<Result> {
  const raw = args[0]
  if (raw === undefined) {
    const err = new TextEncoder().encode('sleep: missing operand\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  // "1e309" passes the regex but overflows to Infinity, so check both.
  const seconds = SLEEP_INTERVAL.test(raw) ? Number(raw) : Infinity
  if (!Number.isFinite(seconds)) {
    const err = new TextEncoder().encode(`sleep: invalid time interval '${raw}'\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  await sleep(seconds * 1000, signal)
  return [null, new IOResult(), new ExecutionNode({ command: 'sleep', exitCode: 0 })]
}
