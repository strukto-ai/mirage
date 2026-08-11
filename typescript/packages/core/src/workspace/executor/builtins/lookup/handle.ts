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
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { lastOf, scanOptions } from '../getopt.ts'
import type { Result } from '../scope.ts'
import { describe, locations } from './classify.ts'
import { TYPE_OPTIONS, TYPE_USAGE, WHICH_OPTIONS, WHICH_USAGE } from './constants.ts'
import { NameKind } from './types.ts'

/** The refusal shape both builtins use for an unknown option. */
function optionError(cmd: string, bad: string, usage: string): Result {
  const err = new TextEncoder().encode(`${cmd}: ${bad}: invalid option\n${usage}`)
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
 * when every name resolves. `-t` prints the classification word,
 * `-p`/`-P` print a path (always empty here) and are one mutually
 * exclusive group with `-t`, `-a` prints one line per layer holding the
 * name (a shell function shadowing an installed CLI is the case that has
 * two), `-f` ignores the function table, and a missing name warns on
 * stderr unless a word-only mode (`-t`/`-p`) is active.
 */
export function handleType(
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const scan = scanOptions(args, TYPE_OPTIONS)
  if (scan.bad !== null) return optionError('type', scan.bad, TYPE_USAGE)
  const enc = new TextEncoder()
  const last = lastOf(scan.letters, 'tpP')
  const mode = last === null || last === 't' ? last : 'p'
  const allMode = scan.letters.includes('a')
  const hidden = scan.letters.includes('f') ? NameKind.FUNCTION : null
  const outLines: string[] = []
  const errLines: string[] = []
  let allFound = true
  for (const name of scan.operands) {
    const kinds = locations(name, session, registry, allMode, hidden)
    if (kinds.length === 0) {
      allFound = false
      if (mode === null) errLines.push(`type: ${name}: not found\n`)
      continue
    }
    if (mode === 't') outLines.push(...kinds.map((kind) => `${kind}\n`))
    else if (mode === null) outLines.push(...kinds.map((kind) => `${describe(name, kind)}\n`))
  }
  const out = outLines.length > 0 ? enc.encode(outLines.join('')) : null
  const err = enc.encode(errLines.join(''))
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
 * Pinned against debianutils `which` (debian:stable-slim): a miss prints
 * nothing at all, the exit status is 0 only when every name resolves (1
 * with no operands), and `-s` reports through the status alone. Two
 * deliberate divergences, both forced by mirage having no PATH: the
 * printed word is the name rather than a path (as `command -v` already
 * does), and every runnable resolves, where GNU reports only files
 * (`which cd` misses there, since a builtin is not on the PATH; here
 * everything is in-process, so reporting nothing would make the command
 * useless). Keywords stay unresolvable, as they are not commands
 * anywhere. `-a` prints one line per layer, so a shadowed name prints
 * its name twice; `type -a` is the surface that names the layers. The
 * refusal for an unknown option is bash's shape, not the C tool's
 * `Illegal option`, because this is a builtin and the usage line cannot
 * honestly name `/usr/bin/which`.
 */
export function handleWhich(
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const scan = scanOptions(args, WHICH_OPTIONS)
  if (scan.bad !== null) return optionError('which', scan.bad, WHICH_USAGE)
  const allMode = scan.letters.includes('a')
  const silent = scan.letters.includes('s')
  const outLines: string[] = []
  let allFound = true
  for (const name of scan.operands) {
    const kinds = locations(name, session, registry, allMode, NameKind.KEYWORD)
    if (kinds.length === 0) {
      allFound = false
      continue
    }
    if (!silent) outLines.push(...Array.from({ length: kinds.length }, () => `${name}\n`))
  }
  const out = outLines.length > 0 ? new TextEncoder().encode(outLines.join('')) : null
  const code = scan.operands.length > 0 && allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'which', exitCode: code }),
  ]
}
