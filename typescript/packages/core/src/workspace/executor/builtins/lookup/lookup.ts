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
import type { MountRegistry } from '../../../mount/registry.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { lastOf, scanOptions } from '../getopt.ts'
import { program } from '../../../lookup/lookup.ts'
import { describe, locations, programFile } from './classify.ts'
import { TYPE_OPTIONS, TYPE_USAGE, WHICH_OPTIONS, WHICH_USAGE } from './constants.ts'
import { NameKind } from './types.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * The refusal shape both builtins use for an unknown option; `voice` is
 * `bash: ` for `type`, a builtin, and empty for `which`, a program.
 */
function optionError(cmd: string, bad: string, usage: string, voice = ''): Result {
  const err = encodeText(`${voice}${cmd}: ${bad}: invalid option\n${usage}`)
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 2, stderr: err }),
  ]
}

/**
 * Run the `type` builtin (`type [-afptP] name [name ...]`).
 *
 * Resolution matches `command -V`, but the exit rule is `type`'s: 0 only
 * when every name resolves. `-t` prints the classification word; `-p`
 * prints the file of a name that resolves to one (none for a builtin,
 * which still resolves) and `-P` searches PATH for one even past a
 * builtin, a miss there being a miss; the three are one group, the last
 * winning. `-a` prints one line per layer holding the name (a builtin
 * that is also a program ends with its file's line), `-f` ignores the
 * function table, and a missing name warns on stderr unless a word-only
 * mode (`-t`/`-p`/`-P`) is active. Pinned against bash 5.2 on
 * debian:stable-slim.
 */
export function handleType(
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): Result {
  const scan = scanOptions(args, TYPE_OPTIONS)
  if (scan.bad !== null) return optionError('type', scan.bad, TYPE_USAGE, 'bash: ')
  const mode = lastOf(scan.letters, 'tpP')
  const allMode = scan.letters.includes('a')
  const hidden = scan.letters.includes('f') ? NameKind.FUNCTION : null
  const outLines: string[] = []
  const errLines: string[] = []
  let allFound = true
  for (const name of scan.operands) {
    if (mode === 'P') {
      if (program(name, session, registry) === null) allFound = false
      else outLines.push(`${programFile(name)}\n`)
      continue
    }
    const kinds = locations(name, session, registry, allMode, hidden)
    if (kinds.length === 0) {
      allFound = false
      if (mode === null) errLines.push(`bash: type: ${name}: not found\n`)
      continue
    }
    if (mode === 't') outLines.push(...kinds.map((kind) => `${kind}\n`))
    else if (mode === 'p') {
      for (const kind of kinds) if (kind === NameKind.FILE) outLines.push(`${programFile(name)}\n`)
    } else outLines.push(...kinds.map((kind) => `${describe(name, kind, session)}\n`))
  }
  const out = outLines.length > 0 ? encodeText(outLines.join('')) : null
  const err = encodeText(errLines.join(''))
  const code = scan.operands.length === 0 || allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: 'type', exitCode: code, stderr: err }),
  ]
}

/**
 * Run the `which` builtin (`which [-as] name [name ...]`).
 *
 * Pinned against debianutils `which` (debian:stable-slim): it prints the
 * file PATH finds for each name, which is the program's under `/usr/bin`
 * (the one PATH directory), a miss prints nothing at all, the exit status
 * is 0 only when every name resolves (1 with no operands), and `-s`
 * reports through the status alone. A builtin with no program (`cd`), a
 * function, an alias and a reserved word are no file, so each is a miss;
 * `-a` has one directory to search and so one line per name. `$PATH`
 * itself is not read: mirage runs a program by its name whatever PATH
 * holds, so `which` answers as dispatch does. The refusal for an unknown
 * option is bash's shape, not the C tool's `Illegal option`, because this
 * is a builtin.
 */
export function handleWhich(
  args: readonly string[],
  session: SessionState,
  registry: MountRegistry,
): Result {
  const scan = scanOptions(args, WHICH_OPTIONS)
  if (scan.bad !== null) return optionError('which', scan.bad, WHICH_USAGE)
  const silent = scan.letters.includes('s')
  const outLines: string[] = []
  let allFound = true
  for (const name of scan.operands) {
    if (program(name, session, registry) === null) {
      allFound = false
      continue
    }
    if (!silent) outLines.push(`${programFile(name)}\n`)
  }
  const out = outLines.length > 0 ? encodeText(outLines.join('')) : null
  const code = scan.operands.length > 0 && allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'which', exitCode: code }),
  ]
}

/** The `type` arm. */
export function typeBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleType([...call.argv.args], call.context.session, call.registry))
}

/** The `which` arm. */
export function whichBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleWhich([...call.argv.args], call.context.session, call.registry))
}
