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

import { IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { route } from '../../route/route.ts'
import { Consumer } from '../../route/types.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

const USAGE = 'command: usage: command [-pVv] command [arg ...]\n'

// bash reserved words: reported by `command -v/-V` as keywords even
// though the parser, not the executor, consumes them.
const KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
  ']]',
])

/**
 * Split `command`'s own options from its operands.
 *
 * bash uses non-permuting getopt: option scanning stops at the first
 * non-option word (or `--`), so a flag after the target name belongs to
 * the target. Only `-p -v -V` are valid; `-p` is accepted but inert
 * (mirage has no PATH), and the last of `-v`/`-V` wins. Returns
 * `[mode, rest, bad]` where `bad` is the first invalid option or null.
 */
export function parseFlags(args: readonly string[]): [string | null, string[], string | null] {
  let mode: string | null = null
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (!(tok.startsWith('-') && tok.length > 1)) break
    for (const ch of tok.slice(1)) {
      if (ch === 'v') mode = 'v'
      else if (ch === 'V') mode = 'V'
      else if (ch === 'p') continue
      else return [null, [], `-${ch}`]
    }
    i += 1
  }
  return [mode, [...args.slice(i)], null]
}

/**
 * Classify a name for `command -v/-V` reporting.
 *
 * Every mirage-native runnable non-function name (shell builtin,
 * namespace command, or mount command) reports as 'builtin': mirage has
 * no external binaries, so there is no honest path to print, and
 * grouping them matches bash's runnable-and-in-process category (a
 * deliberate divergence from bash's file paths).
 */
function classify(name: string, session: Session, registry: MountRegistry): string {
  if (KEYWORDS.has(name)) return 'keyword'
  const consumer = route(name, session, registry)
  if (consumer === Consumer.FUNCTION) return 'function'
  if (consumer === Consumer.UNKNOWN) return 'not_found'
  return 'builtin'
}

function describe(name: string, kind: string): string {
  if (kind === 'keyword') return `${name} is a shell keyword`
  if (kind === 'function') return `${name} is a function`
  return `${name} is a shell builtin`
}

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
    if (kind === 'not_found') {
      if (mode === 'V') errLines.push(`command: ${name}: not found`)
      continue
    }
    anyFound = true
    outLines.push(mode === 'v' ? name : describe(name, kind))
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
 * token each; the pipe stdin flows to the inner command.
 */
export async function handleCommandBuiltin(
  executeFn: ExecuteStringFn,
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
  stdin: ByteSource | null = null,
): Promise<Result> {
  const [mode, rest, bad] = parseFlags(args)
  if (bad !== null) {
    const err = new TextEncoder().encode(`command: ${bad}: invalid option\n${USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'command', exitCode: 2, stderr: err }),
    ]
  }
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
  try {
    const io = await executeFn(inner, { sessionId: session.sessionId, stdin })
    return [io.stdout, io, new ExecutionNode({ command: 'command', exitCode: io.exitCode })]
  } finally {
    if (savedFn !== undefined) session.functions[innerName] = savedFn
  }
}
