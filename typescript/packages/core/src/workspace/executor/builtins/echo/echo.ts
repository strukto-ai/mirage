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

import { ECHO_OPTION } from '../../../../commands/spec/constants.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { ExecutionNode } from '../../../types.ts'
import type { BuiltinCall } from '../types.ts'
import { interpretEscapes } from './escapes.ts'

/**
 * Print arguments, honoring GNU echo's option rules.
 *
 * GNU echo is not getopt: options are LEADING words matching `-[neE]+`
 * only. The first word that does not match (including `-x` or a
 * repeated `hi -n`) ends option parsing and prints literally. Within
 * clusters the last of -e/-E wins; -n sticks. Under -e a `\c` ends the
 * output where it stands, newline included.
 */
export function handleEcho(args: string[]): RedirectResult {
  let noNewline = false
  let escapes = false
  let idx = 0
  for (const word of args) {
    if (!ECHO_OPTION.test(word)) break
    for (const ch of word.slice(1)) {
      if (ch === 'n') noNewline = true
      else if (ch === 'e') escapes = true
      else escapes = false
    }
    idx += 1
  }
  let text = args.slice(idx).join(' ')
  let stop = false
  if (escapes) [text, stop] = interpretEscapes(text)
  if (!noNewline && !stop) text += '\n'
  const out = encodeText(text)
  return [out, new IOResult(), new ExecutionNode({ command: 'echo', exitCode: 0 })]
}

/** The `echo` arm. */
export function echoBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return Promise.resolve(handleEcho([...call.argv.args]))
}
