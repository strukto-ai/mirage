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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { CallStack } from '../../../../shell/call_stack.ts'
import { shellJoin } from '../../../../shell/join.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'
import { singleQuote } from '../../../../utils/quote.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { sessionEntry } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { aliasesOn } from '../alias/alias.ts'
import { lastOf, scanOptions } from '../getopt.ts'
import { classify, describe, programFile } from '../lookup/index.ts'
import { NameKind } from '../lookup/types.ts'
import { builtinUsage, result, written } from '../shared.ts'
import { BASH_BUILTINS, KEYWORDS, SHELL_NAMES } from '../../../lookup/constants.ts'
import type { BuiltinCall, ExecuteStringFn } from '../types.ts'

/**
 * Run the `-v`/`-V` introspection modes.
 *
 * The exit status is 0 when no names are given, otherwise 0 if any name
 * resolved and 1 if none did (bash's `command` uses this any-found rule,
 * unlike `type`'s all-found rule). `-v` prints a program's file and any
 * other resolvable name bare (a builtin, a function); `-V` prints a
 * verbose line. Not-found names are silent under `-v` and warn on stderr
 * under `-V`.
 */
function probe(
  mode: string,
  rest: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  parser?: ParseScope,
): RedirectResult {
  const pieces: [boolean, string][] = []
  let anyFound = false
  for (const name of rest) {
    const kind = classify(name, session, registry)
    if (kind === null) {
      if (mode === 'V') pieces.push([true, `${shellVoice()}command: ${name}: not found\n`])
      continue
    }
    anyFound = true
    // `command -v` prints an alias as its definition, the one form that
    // is not just the name.
    const line =
      mode === 'V'
        ? describe(name, kind, session, parser)
        : kind === NameKind.ALIAS
          ? `alias ${name}=${singleQuote(sessionEntry(session.aliases, name) ?? '')}`
          : kind === NameKind.FILE
            ? programFile(name)
            : name
    pieces.push([false, `${line}\n`])
  }
  // The status and the diagnostics are independent: bash prints `command:
  // nope: not found` for a missing name and still exits 0 when another name
  // resolved.
  const code = rest.length === 0 || anyFound ? 0 : 1
  return written('command', pieces, code)
}

/**
 * Run the `command` builtin (`command [-pVv] name [arg ...]`).
 *
 * Without `-v`/`-V` it runs the target ignoring any shell function of the
 * same name (bash's function bypass): the name is masked in the session
 * function table for the inner run so a shadowing function is skipped
 * while builtins and mount commands still resolve. Already expanded
 * operands are re-joined with shellJoin so they survive re-parsing as one
 * token each; the pipe stdin flows to the inner command. `-p` is accepted
 * but inert (the default PATH is the one PATH there is) and the last of
 * `-v`/`-V` wins.
 */
export async function handleCommandBuiltin(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
  stdin: ByteSource | null = null,
  // The caller's frames: the target runs in them, as a builtin does in
  // bash, so an `exit` in it ends the shell and a `return` the function.
  // Null runs the target as a line of its own.
  callStack: CallStack | null = null,
  parser?: ParseScope,
): Promise<RedirectResult> {
  const scan = scanOptions(args, 'pvV')
  if (scan.bad !== null) {
    const err = encodeText(
      `${shellVoice()}command: ${scan.bad}: invalid option\n${builtinUsage('command')}`,
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'command', exitCode: 2, stderr: err }),
    ]
  }
  const mode = lastOf(scan.letters, 'vV')
  const rest = scan.operands
  if (mode !== null) return probe(mode, rest, session, registry, parser)
  if (rest.length === 0) {
    return [null, new IOResult(), new ExecutionNode({ command: 'command', exitCode: 0 })]
  }

  return pastFunctions('command', executeFn, rest, session, stdin, callStack)
}

/**
 * Run `words` past a shell function or alias of their head's name. A head the
 * line would read as more than a name is single-quoted, as bash takes the word
 * as it is: one an alias would expand, so the alias table stays whole for the
 * builtin to read (`builtin alias alias`), a reserved word (`command time`) and
 * an assignment (`command X=5`). Any other head goes as typed. A shadowing function is masked in the session for the inner
 * run while builtins and mount commands still resolve. `cmd` is the builtin
 * that runs them, named on the node. Mirrors Python's _past_functions.
 */
async function pastFunctions(
  cmd: string,
  executeFn: ExecuteStringFn,
  words: readonly string[],
  session: SessionState,
  stdin: ByteSource | null,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const innerName = words[0] ?? ''
  const rest = shellJoin(words.slice(1))
  const quoted =
    innerName.includes('=') ||
    KEYWORDS.has(innerName) ||
    (aliasesOn(session) && sessionEntry(session.aliases, innerName) !== undefined)
  const inner = quoted ? singleQuote(innerName) + (rest === '' ? '' : ` ${rest}`) : shellJoin(words)
  // A function never shadows a bash builtin mirage runs, so one of such a name
  // stays for the builtin to read or remove (`builtin unset -f unset`); an
  // interpreter's (`python3`) is still masked. Function bodies are never
  // undefined, so a defined captured value means a shadowing function was
  // masked and must be restored after the run.
  const savedFn =
    BASH_BUILTINS.has(innerName) && SHELL_NAMES.has(innerName)
      ? undefined
      : session.functions[innerName]
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  if (savedFn !== undefined) delete session.functions[innerName]
  try {
    const io = await executeFn(inner, {
      sessionId: session.sessionId,
      stdin,
      ...(callStack !== null ? { callStack } : {}),
    })
    return [io.stdout, io, new ExecutionNode({ command: cmd, exitCode: io.exitCode })]
  } finally {
    if (savedFn !== undefined) session.functions[innerName] = savedFn
  }
}

/**
 * Run the `builtin` builtin (`builtin [shell-builtin [arg ...]]`): a shell
 * builtin past a function or alias of its name, in the caller's frames as
 * `command` does, and a refusal of any other word (`builtin: ls: not a shell
 * builtin`, status 1); with no word it does nothing. `--` ends its options
 * and any other one is refused with status 2. Pinned against bash 5.2 on
 * debian:stable-slim. Mirrors Python's handle_builtin.
 */
export async function handleBuiltin(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: SessionState,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<RedirectResult> {
  let words = args
  const first = words[0]
  if (first === '--') words = words.slice(1)
  else if (first !== undefined && first.startsWith('-') && first !== '-') {
    return result('builtin', {
      exitCode: 2,
      stderr: `${shellVoice()}builtin: ${first}: invalid option\n${builtinUsage('builtin')}`,
    })
  }
  const name = words[0]
  if (name === undefined) return result('builtin')
  if (!BASH_BUILTINS.has(name)) {
    return result('builtin', {
      exitCode: 1,
      stderr: `${shellVoice()}builtin: ${name}: not a shell builtin\n`,
    })
  }
  return pastFunctions('builtin', executeFn, words, session, stdin, callStack)
}

/** The `builtin` arm. */
export async function builtinBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handleBuiltin(
    call.executeFn,
    [...call.argv.args],
    call.context.session,
    call.stdin,
    call.callStack,
  )
}

/** The `command` arm. */
export async function commandBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handleCommandBuiltin(
    call.executeFn,
    [...call.argv.args],
    call.context.session,
    call.registry,
    call.stdin,
    call.callStack,
    call.parser,
  )
}
