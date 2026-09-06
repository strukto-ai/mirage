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

import { IOResult } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { shellJoin } from '../../../../shell/join.ts'
import { singleQuote } from '../../../../utils/quote.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { lastOf, scanOptions } from '../getopt.ts'
import { classify, describe } from '../lookup/index.ts'
import { NameKind } from '../lookup/types.ts'
import { sessionEntry } from '../../../session/session.ts'
import type { BuiltinCall, ExecuteStringFn, Result } from '../types.ts'

const USAGE = 'command: usage: command [-pVv] command [arg ...]\n'

/**
 * Run the `-v`/`-V` introspection modes.
 *
 * The exit status is 0 when no names are given, otherwise 0 if any name
 * resolved and 1 if none did (bash's `command` uses this any-found rule,
 * unlike `type`'s all-found rule). `-v` prints the name for a resolvable
 * command (no fake path); `-V` prints a verbose line. Not-found names are
 * silent under `-v` and warn on stderr under `-V`.
 */
function probe(
  mode: string,
  rest: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const outLines: string[] = []
  const errLines: string[] = []
  let anyFound = false
  for (const name of rest) {
    const kind = classify(name, session, registry)
    if (kind === null) {
      if (mode === 'V') errLines.push(`command: ${name}: not found`)
      continue
    }
    anyFound = true
    // `command -v` prints an alias as its definition, the one form that
    // is not just the name.
    const line =
      mode === 'V'
        ? describe(name, kind, session)
        : kind === NameKind.ALIAS
          ? `alias ${name}=${singleQuote(sessionEntry(session.aliases, name) ?? '')}`
          : name
    outLines.push(line)
  }
  const enc = new TextEncoder()
  const out = outLines.length > 0 ? enc.encode(`${outLines.join('\n')}\n`) : null
  const err = errLines.length > 0 ? enc.encode(`${errLines.join('\n')}\n`) : new Uint8Array()
  const code = rest.length === 0 || anyFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: 'command', exitCode: code, stderr: err }),
  ]
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
 * but inert (mirage has no PATH) and the last of `-v`/`-V` wins.
 */
export async function handleCommandBuiltin(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
  stdin: ByteSource | null = null,
): Promise<Result> {
  const scan = scanOptions(args, 'pvV')
  if (scan.bad !== null) {
    const err = new TextEncoder().encode(`command: ${scan.bad}: invalid option\n${USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'command', exitCode: 2, stderr: err }),
    ]
  }
  const mode = lastOf(scan.letters, 'vV')
  const rest = scan.operands
  if (mode !== null) return probe(mode, rest, session, registry)
  if (rest.length === 0) {
    return [null, new IOResult(), new ExecutionNode({ command: 'command', exitCode: 0 })]
  }

  const innerName = rest[0] ?? ''
  const inner = shellJoin(rest)
  // Function bodies are never undefined, so a defined captured value means
  // a shadowing function was masked and must be restored after the run.
  const savedFn = session.functions[innerName]
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.functions[innerName]
  // An alias is masked the same way: bash expands an alias only as a
  // command's first word, which `command` is, so `command cat` runs the
  // program past `alias cat=...` too.
  const savedAlias = session.aliases[innerName]
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.aliases[innerName]
  try {
    const io = await executeFn(inner, { sessionId: session.sessionId, stdin })
    return [io.stdout, io, new ExecutionNode({ command: 'command', exitCode: io.exitCode })]
  } finally {
    if (savedFn !== undefined) session.functions[innerName] = savedFn
    if (savedAlias !== undefined) session.aliases[innerName] = savedAlias
  }
}

/** The `command` arm. */
export async function commandBuiltin(call: BuiltinCall): Promise<Result> {
  return handleCommandBuiltin(
    call.executeFn,
    [...call.argv.args],
    call.session,
    call.registry,
    call.stdin,
  )
}
