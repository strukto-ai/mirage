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
import {
  SET_OPTION_DEFAULTS,
  SET_OPTION_NAMES,
  SHOPT_DEFAULTS,
  SHOPT_UNSUPPORTED,
} from '../../../../shell/constants.ts'
import type { SessionState } from '../../../session/session.ts'
import { lastOf, scanOptions } from '../getopt.ts'
import { ExecutionNode } from '../../../types.ts'
import { fail } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'

const USAGE = 'shopt: usage: shopt [-pqsu] [-o] [optname ...]'

/** Whether a `shopt` option is on for the session. */
export function shoptEnabled(session: SessionState, name: string): boolean {
  return session.shopts[name] ?? SHOPT_DEFAULTS.get(name) ?? false
}

function row(name: string, on: boolean, reusable: boolean, setO: boolean): string {
  if (reusable) {
    if (setO) return `set ${on ? '-' : '+'}o ${name}`
    return `shopt -${on ? 's' : 'u'} ${name}`
  }
  return `${name.padEnd(15)}\t${on ? 'on' : 'off'}`
}

/**
 * Set, unset, print or query the `shopt` options. Bare `shopt` lists
 * every option, `-p` prints re-readable lines, `-s`/`-u` set or clear
 * (or list the on/off ones when given no name), `-q` prints nothing and
 * answers 0 only when every named option is on, and `-o` moves all of
 * that onto the `set -o` vocabulary. An unknown name is `invalid shell
 * option name` (or `invalid option name` under `-o`), exit 1; `-s` with
 * `-u` is refused; an unknown letter is exit 2. `shopt -s extglob` is
 * refused: the parser has no such mode.
 */
export function handleShopt(args: string[], session: SessionState): Result {
  const scan = scanOptions(args, 'pqosu')
  if (scan.bad !== null)
    return fail('shopt', `bash: shopt: ${scan.bad}: invalid option\n${USAGE}\n`, 2)
  if (scan.letters.includes('s') && scan.letters.includes('u')) {
    return fail('shopt', 'bash: shopt: cannot set and unset shell options simultaneously\n', 1)
  }
  const reusable = scan.letters.includes('p')
  const quiet = scan.letters.includes('q')
  const setO = scan.letters.includes('o')
  const chosen = lastOf(scan.letters, 'su')
  const setting = chosen === null ? null : chosen === 's'
  const names = scan.operands
  const table = setO ? SET_OPTION_DEFAULTS : SHOPT_DEFAULTS
  const store = setO ? session.shellOptions : session.shopts
  const lines: string[] = []
  const errors: string[] = []
  let status = 0
  if (names.length === 0) {
    for (const [name, def] of table) {
      const on = store[name] ?? def
      if (setting !== null && on !== setting) continue
      if (!quiet) lines.push(row(name, on, reusable, setO))
    }
    const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
    return [out, new IOResult(), new ExecutionNode({ command: 'shopt', exitCode: 0 })]
  }
  for (const name of names) {
    if (!table.has(name) || (setO && !SET_OPTION_NAMES.has(name))) {
      errors.push(`bash: shopt: ${name}: invalid ${setO ? 'option name' : 'shell option name'}`)
      status = 1
      continue
    }
    if (setting === null) {
      const on = store[name] ?? table.get(name) ?? false
      if (!on) status = 1
      if (!quiet) lines.push(row(name, on, reusable, setO))
      continue
    }
    if (setting && !setO && SHOPT_UNSUPPORTED.has(name)) {
      errors.push(`mirage: shopt: ${name}: not supported`)
      status = 1
      continue
    }
    store[name] = setting
  }
  const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
  const err = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : null
  return [
    out,
    new IOResult({ exitCode: status, stderr: err }),
    new ExecutionNode({
      command: 'shopt',
      exitCode: status,
      ...(err !== null ? { stderr: err } : {}),
    }),
  ]
}

/** The `shopt` arm. */
export function shoptBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleShopt([...call.argv.args], call.session))
}
