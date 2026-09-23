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
import type { CallStack } from '../../../../shell/call_stack.ts'
import { parseOptionWord } from '../../../../shell/options.ts'
import { SET_OPTION_DEFAULTS, SET_OPTION_NAMES } from '../../../../shell/constants.ts'
import type { SessionState } from '../../../session/session.ts'
import { visibleEnv } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { BuiltinCall, Result } from '../types.ts'

export function handleSet(
  args: string[],
  session: SessionState,
  _callStack: CallStack | null = null,
): Result {
  if (args.length === 0) {
    const lines = Object.entries(visibleEnv(session)).map(([k, v]) => `${k}=${v}`)
    lines.sort(compareCodePoints)
    const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
  }
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      session.positionalArgs = args.slice(i + 1)
      return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
    }
    // `-o` and `+o` with nothing after them print the option table
    // instead of setting anything, in two different spellings: `-o`
    // as a padded name/value column, `+o` as lines that can be fed
    // back to `set`. Both are checked before the option grammar,
    // since a bare `-o` is not a setting.
    if ((tok === '-o' || tok === '+o') && i + 1 >= args.length) {
      const out = optionListing(session, tok === '+o')
      return [out, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
    }
    const word = parseOptionWord(tok, args[i + 1] ?? null)
    if (word === null) {
      session.positionalArgs = args.slice(i)
      break
    }
    for (const [option, enable] of word.settings) {
      // `-o` takes a name rather than a letter, and a name bash does not
      // have is the one thing it refuses: exit 2, and the settings already
      // applied stay applied while the rest of the line is dropped.
      // Without this a typo — or an option mirage has yet to wire, as
      // `physical` once was — reads as success.
      if (!SET_OPTION_NAMES.has(option)) {
        const err = new TextEncoder().encode(`set: ${option}: invalid option name\n`)
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: 'set', exitCode: 2, stderr: err }),
        ]
      }
      session.shellOptions[option] = enable
    }
    // A letter naming no option is ignored rather than refused: bash has
    // options mirage does not implement (`-a`, `-B`, `-H`), and `set` is
    // where a script turns those on without wanting to fail. A nested shell
    // answers the same leftovers differently, which is why the grammar hands
    // them back instead of deciding here.
    i += word.consumed
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
}

/**
 * Render `set -o` or `set +o` with no name after it.
 *
 * GNU 5.2.37 prints every option it knows, alphabetically, whether or
 * not the shell has been told anything about it: `-o` as a name padded
 * to 15 columns, a tab, then `on`/`off`, and `+o` as `set -o NAME` /
 * `set +o NAME` lines a script can source back. `interactive-comments`
 * is longer than the padding and simply overflows it, which is GNU's
 * own `%-15s\t%s` and not a special case.
 */
function optionListing(session: SessionState, plus: boolean): Uint8Array {
  const lines: string[] = []
  for (const [name, byDefault] of SET_OPTION_DEFAULTS) {
    const on = session.shellOptions[name] ?? byDefault
    if (plus) {
      lines.push(`set ${on ? '-' : '+'}o ${name}`)
    } else {
      lines.push(`${name.padEnd(15)}\t${on ? 'on' : 'off'}`)
    }
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

/** The `set` arm. */
export function setBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleSet([...call.argv.args], call.session, call.callStack))
}
