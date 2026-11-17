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

import { renderHelp } from '../../../../commands/spec/help.ts'
import { SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { versionLine } from '../../../../commands/spec/standard.ts'
import { SYNOPSES } from '../../../../commands/spec/synopsis.ts'
import { lineOutput } from '../../../../commands/builtin/general/interpreter.ts'
import {
  currentCaller,
  runAsProgram,
  setTraits,
  type RedirectResult,
} from '../../../../context/session_context.ts'
import type { ProcessTraits } from '../../../../execution/process/types.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import { chunks } from '../../../../io/cooperative.ts'
import type { Runtime } from '../../../../runtime/base.ts'
import type { RouteDecision } from '../../../../runtime/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { Channel } from '../../../../shell/console/index.ts'
import { SIGHUP } from '../../../../shell/constants.ts'
import { shellJoin } from '../../../../shell/join.ts'
import type { ExecuteFn } from '../../../expand/types.ts'
import {
  DEFAULT_NICENESS,
  LOWEST_PRIORITY,
  PROGRAM_WRAPPERS,
  niceAdjustment,
  readWrapper,
} from '../../../lookup/constants.ts'
import { execs as found, lookup, pathProgram, runsWrapper } from '../../../lookup/lookup.ts'
import { Consumer, WrapperAnswer } from '../../../lookup/types.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'

/**
 * Run the program a wrapper runs, as a program, its output handed over as it
 * runs. Mirrors Python's `_run_program`.
 */
/**
 * Run a wrapper's program in Mirage, as the program it execs, its output
 * handed over as it runs: the process it runs as, and all it starts, carry
 * what the wrapper changed. `warned` is what the wrapper says before it runs
 * the program. Mirrors Python's `_run_program`.
 */
function runProgram(
  executeFn: ExecuteFn,
  name: string,
  line: string,
  session: SessionState,
  stdin: ByteSource | null,
  traits: ProcessTraits,
  warned = '',
): RedirectResult {
  const node = new ExecutionNode({ command: name })
  const [stdout, io] = lineOutput(async (sink, signal) => {
    if (warned !== '') await sink.emit(Channel.STDERR, encodeText(warned))
    return runAsProgram(session, () =>
      setTraits(traits, async () => {
        const ran = await executeFn(line, {
          sessionId: session.sessionId,
          signal,
          sink,
          ...(stdin !== null ? { stdin } : {}),
        })
        for await (const chunk of chunks(ran.stdout ?? new Uint8Array()))
          await sink.emit(Channel.STDOUT, chunk)
        for await (const chunk of chunks(ran.stderr ?? new Uint8Array()))
          await sink.emit(Channel.STDERR, chunk)
        node.exitCode = ran.exitCode
        return new IOResult({ exitCode: ran.exitCode })
      }),
    )
  })
  return [stdout, io, node]
}

/**
 * A wrapper Mirage runs (`nice`, `nohup`, `setsid`, `stdbuf`, `ionice`): it
 * answers for itself (`nice` alone, a bad option, a program it cannot exec),
 * or execs its program with what it changes (`wrapperTraits`). The runner it
 * runs as, when it is a job's or a stage's one command, becomes the program;
 * the program is judged, placed and run as any command is, and a machine with
 * processes of its own is handed the wrapper's words before it. Mirrors
 * Python's `handle_wrapper`.
 */
export function handleWrapper(
  executeFn: ExecuteFn,
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  stdin: ByteSource | null,
  routing: RouteDecision<Runtime> | undefined,
): RedirectResult {
  const caller = currentCaller()
  const answer = wrapperAnswer(name, args, session, registry, caller.traits.niceness)
  if (answer.runsFrom === null) {
    const err = encodeText(answer.stderr)
    return [
      answer.stdout === '' ? null : encodeText(answer.stdout),
      new IOResult({
        exitCode: answer.exitCode,
        ...(err.byteLength > 0 ? { stderr: err } : {}),
      }),
      new ExecutionNode({ command: name, exitCode: answer.exitCode, stderr: err }),
    ]
  }
  const [traits, warned] = wrapperTraits(name, args, answer.runsFrom, caller.traits)
  const line = shellJoin(args.slice(answer.runsFrom))
  const program = args.slice(answer.runsFrom)
  const wrapped = caller.process?.wrap(traits, line, execs(program, session, registry, routing))
  const worn = wrapped === true ? { ...traits, leads: false } : traits
  return runProgram(executeFn, name, line, session, stdin, worn, warned)
}

/**
 * Whether a wrapper's program runs on in the wrapper's place: another wrapper
 * Mirage runs, or a program a machine takes, which may take the runner as its
 * own. A command Mirage runs itself (a shell, `grep`) runs its own commands,
 * which do not. Mirrors Python's `_execs`.
 */
function execs(
  words: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
): boolean {
  const word = words[0] ?? ''
  const head = pathProgram(word, session, registry) ?? word
  if (runsWrapper(head, words.slice(1), session, registry, routing)) return true
  return lookup(head, session, registry, routing) === Consumer.EXTERNAL
}

/**
 * What a wrapper changes for the program at `at` in its words, over the
 * traits it runs under, and what it warns first: `nice` the niceness (10
 * more, or its adjustment, never past 19; a negative one is refused, as for a
 * user who is not root), `nohup` HUP ignored, `setsid` a group and session of
 * its own. Each records its words for a machine with processes of its own.
 * Mirrors Python's `wrapper_traits`.
 */
export function wrapperTraits(
  name: string,
  args: readonly string[],
  at: number,
  traits: ProcessTraits,
): [ProcessTraits, string] {
  const worn: ProcessTraits = {
    ...traits,
    wrappers: [...traits.wrappers, name, ...args.slice(0, at)],
  }
  if (name === 'nice') {
    const adjustment = niceAdjustment(args.slice(0, at))
    if (adjustment !== null && adjustment < 0)
      return [worn, 'nice: cannot set niceness: Permission denied\n']
    const step = adjustment ?? DEFAULT_NICENESS
    return [{ ...worn, niceness: Math.min(traits.niceness + step, LOWEST_PRIORITY) }, '']
  }
  if (name === 'nohup') return [{ ...worn, ignores: new Set([...worn.ignores, SIGHUP]) }, '']
  if (name === 'setsid') return [{ ...worn, leads: true }, '']
  return [worn, '']
}

export function wrapperRefusal(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): [number, string] | null {
  const grammar = PROGRAM_WRAPPERS.get(name)
  if (grammar === undefined) return null
  const [at, error] = readWrapper(name, args)
  if (error !== null) return [grammar.status, error]
  if (at === null) return null
  const inner = args[at] ?? ''
  if (!PROGRAM_WRAPPERS.has(inner) && !found(inner, session, registry)) {
    return [127, grammar.missing.replace('{}', inner)]
  }
  return null
}

function usage(name: string, line: string, status: number): WrapperAnswer {
  return new WrapperAnswer({
    exitCode: status,
    stderr: `${line}\nTry '${name} --help' for more information.\n`,
  })
}

/** The `--help` or `--version` a wrapper's options stopped at. */
function helpWord(args: readonly string[]): string | null {
  for (const word of args) {
    if (word === '--' || !word.startsWith('-')) return null
    if (word.length > 2 && '--help'.startsWith(word)) return '--help'
    if (word.length > 2 && '--version'.startsWith(word)) return '--version'
  }
  return null
}

/**
 * `nice` with nothing to run: the niceness it runs at, an adjustment with
 * nothing to run refused. Mirrors Python's `_niceness`.
 */
function niceness(args: readonly string[], level: number): WrapperAnswer {
  if (niceAdjustment(args) !== null)
    return usage('nice', 'nice: a command must be given with an adjustment', 125)
  return new WrapperAnswer({ stdout: `${String(level)}\n` })
}

/**
 * What a wrapper Mirage runs does: refuse the line, say what it is, print the
 * niceness, or run its program (`runsFrom`). `level` is the niceness of the
 * process it runs as. Mirrors Python's `wrapper_answer`.
 */
export function wrapperAnswer(
  name: string,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  level = 0,
): WrapperAnswer {
  const refused = wrapperRefusal(name, args, session, registry)
  if (refused !== null) {
    const [code, said] = refused
    return new WrapperAnswer({ exitCode: code, stderr: said })
  }
  const [at] = readWrapper(name, args)
  if (at !== null) return new WrapperAnswer({ runsFrom: at })
  const word = helpWord(args)
  if (word === '--version') return new WrapperAnswer({ stdout: versionLine(name) })
  if (word === '--help') {
    const spec = SHELL_SPECS[name]
    if (spec === undefined) throw new Error(`${name}: no spec`)
    return new WrapperAnswer({ stdout: renderHelp(name, spec, [], undefined, SYNOPSES[name]) })
  }
  if (name === 'nice') return niceness(args, level)
  if (name === 'setsid') return usage(name, 'setsid: no command specified', 1)
  return usage(name, `${name}: missing operand`, 125)
}
