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
import { HISTORY_PREFIX } from '../../../resource/history/history.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'
import type { FlagValue } from '../../../commands/spec/types.ts'

const ENC = new TextEncoder()

const USAGE =
  'history: usage: history [-c] [-d offset] [n] or ' +
  'history -awrn [filename] or history -ps arg [arg...]\n'
const OPTION_CHARS = 'cdanrwsp'

function usageError(message: string): Result {
  const err = ENC.encode(message + USAGE)
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: 'history', exitCode: 2, stderr: err }),
  ]
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
          return { flags: {}, texts: [], error: `history: -${ch}: invalid option\n` }
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
            return { flags: {}, texts: [], error: 'history: -d: option requires an argument\n' }
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
 * Dispatch the history shell builtin to the /.bash_history view mount.
 *
 * GNU lookup order: builtins resolve before mount commands, so a
 * mount-local command named "history" can never shadow this one. The
 * semantics live on the view resource; this handler parses options and
 * routes.
 */
export async function handleHistory(
  registry: MountRegistry,
  args: string[],
  session: Session,
): Promise<Result> {
  const { flags, texts, error } = parseArgs(args)
  if (error !== null) return usageError(error)
  const mount = registry.mountFor(HISTORY_PREFIX)
  if (mount === null) {
    const err = ENC.encode('history: not enabled for this workspace\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'history', exitCode: 1, stderr: err }),
    ]
  }
  const [stream, io] = await mount.executeCmd('history', [], texts, flags, {
    cwd: session.cwd,
    sessionId: session.sessionId,
  })
  // The view command always returns byte stderr, but io.stderr is typed
  // as a ByteSource (a possible lazy stream); resolve it to bytes so the
  // execution-tree node holds concrete stderr, never an unread stream.
  const stderr = await io.materializeStderr()
  return [stream, io, new ExecutionNode({ command: 'history', exitCode: io.exitCode, stderr })]
}
