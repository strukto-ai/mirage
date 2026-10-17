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

import { specOf } from '../../../../commands/spec/builtins.ts'
import { FlagView } from '../../../../commands/spec/flag_view.ts'
import type { FlagValue } from '../../../../commands/spec/types.ts'
import { renderHistoryListing } from '../../../../core/history/render.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { ExitSignal } from '../../../../shell/errors.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall, Result } from '../types.ts'

const USAGE =
  'history: usage: history [-c] [-d offset] [n] or ' +
  'history -anrw [filename] or history -ps arg [arg...]\n'
const OPTION_CHARS = 'cdanrwsp'

/** The builtin's output, status and execution-tree node. */
function result(stdout: Uint8Array | null, exitCode = 0, stderr: Uint8Array | null = null): Result {
  return [
    stdout,
    new IOResult({ exitCode, stderr }),
    new ExecutionNode({ command: 'history', exitCode, stderr: stderr ?? new Uint8Array() }),
  ]
}

function outOfRange(value: string): Result {
  return result(null, 1, encodeText(`bash: history: ${value}: history position out of range\n`))
}

// Mirrors Python int(): trims surrounding whitespace, accepts an
// optional sign, requires all digits. Unlike Number.parseInt it rejects
// trailing garbage ("3abc") and decimals ("3.5"), matching bash, which
// treats those as a non-numeric argument.
function parseIntStrict(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return null
  return Number.parseInt(trimmed, 10)
}

interface ParsedArgs {
  flags: Record<string, FlagValue>
  texts: string[]
  error: string | null
}

function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {}
  const texts: string[] = []
  let optionsDone = false
  let i = 0
  while (i < args.length) {
    const token = args[i] ?? ''
    if (optionsDone || token === '-' || !token.startsWith('-')) {
      texts.push(token)
      optionsDone = true
    } else if (token === '--') {
      optionsDone = true
    } else {
      let j = 1
      while (j < token.length) {
        const ch = token[j] ?? ''
        if (!OPTION_CHARS.includes(ch)) {
          return { flags: {}, texts: [], error: `bash: history: -${ch}: invalid option\n` }
        }
        flags[ch] = true
        if (ch === 'd') {
          const rest = token.slice(j + 1)
          if (rest) {
            flags.d = rest
          } else if (i + 1 < args.length) {
            i += 1
            flags.d = args[i] ?? ''
          } else {
            return {
              flags: {},
              texts: [],
              error: 'bash: history: -d: option requires an argument\n',
            }
          }
          break
        }
        j += 1
      }
    }
    i += 1
  }
  return { flags, texts, error: null }
}

/**
 * GNU's history builtin over the workspace's recorder.
 *
 * GNU lookup order: builtins resolve before mount commands, so a
 * mount-local command named "history" can never shadow this one.
 * -a/-r/-w/-n are accepted no-ops: bash uses them to sync the in-memory
 * list with the histfile, but here both are the same store and always
 * in sync. -p prints its args verbatim; when -s and -p are combined, -s
 * wins and nothing is printed (bash-verified).
 */
export async function handleHistory(
  registry: MountRegistry,
  args: string[],
  session: SessionState,
): Promise<Result> {
  const { flags, texts, error } = parseArgs(args)
  if (error !== null) return result(null, 2, encodeText(error + USAGE))
  // bash abandons everything still to run, as `exit 1 2` does; `-p` and
  // `-s` take any number of words.
  if (Object.keys(flags).length === 0 && texts.length > 1) {
    throw new ExitSignal(1, encodeText('bash: history: too many arguments\n'))
  }
  const observer = registry.observer
  if (observer === null) {
    return result(null, 1, encodeText('bash: history: not enabled for this workspace\n'))
  }
  const fl = new FlagView(flags, specOf('history'))
  const c = fl.asBool('c')
  const d = fl.asStr('d')
  const s = fl.asBool('s')
  const p = fl.asBool('p')
  const sid = session.sessionId
  if (c) await observer.logClear(sid)
  if (d !== undefined) {
    const offset = parseIntStrict(d)
    if (offset === null) return outOfRange(d)
    const visible = await observer.sessionCommandEvents(sid)
    const idx = offset > 0 ? offset - 1 : visible.length + offset
    if (idx < 0 || idx >= visible.length) return outOfRange(d)
    await observer.logDelete(sid, offset)
  }
  if (s && texts.length > 0) {
    await observer.logCommandText(texts.join(' '), sid, session.cwd)
  }
  if (p && !s) {
    return result(encodeText(texts.length > 0 ? texts.join('\n') + '\n' : ''))
  }
  if (
    c ||
    d !== undefined ||
    s ||
    fl.asBool('a') ||
    fl.asBool('r') ||
    fl.asBool('w') ||
    fl.asBool('n')
  ) {
    return result(null)
  }
  let count: number | undefined
  const arg = texts[0]
  if (arg !== undefined) {
    const parsed = parseIntStrict(arg)
    if (parsed === null) {
      return result(null, 1, encodeText(`bash: history: ${arg}: numeric argument required\n`))
    }
    count = parsed
  }
  const events = await observer.sessionCommandEvents(sid)
  return result(encodeText(renderHistoryListing(events, count)))
}

/** The `history` arm. */
export async function historyBuiltin(call: BuiltinCall): Promise<Result> {
  return handleHistory(call.registry, [...call.argv.args], call.context.session)
}
