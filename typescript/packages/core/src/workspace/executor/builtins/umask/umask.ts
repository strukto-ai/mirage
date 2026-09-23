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
import { parseChmod } from '../../../../utils/mode.ts'
import type { SessionState } from '../../../session/session.ts'
import { scanOptions } from '../getopt.ts'
import { ExecutionNode } from '../../../types.ts'
import { fail } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'

const USAGE = 'umask: usage: umask [-p] [-S] [mode]'

/** Render a mask the way `umask -S` does: the bits it leaves on. */
export function symbolicUmask(mask: number): string {
  const perms = 0o777 & ~mask
  const parts: string[] = []
  for (const [who, shift] of [
    ['u', 6],
    ['g', 3],
    ['o', 0],
  ] as const) {
    const bits = (perms >> shift) & 0o7
    const letters = (bits & 4 ? 'r' : '') + (bits & 2 ? 'w' : '') + (bits & 1 ? 'x' : '')
    parts.push(`${who}=${letters}`)
  }
  return parts.join(',')
}

/**
 * The mask a `umask` operand names, or the error bash prints for it.
 * An all-digit operand is octal, refused with `octal number out of
 * range` when it holds an 8 or 9 and clamped to 0777 when octal but too
 * large; anything else is a symbolic clause list applied to the
 * permissions the current mask leaves on. The two symbolic refusals are
 * told apart: a letter outside `ugoa` where an operator was expected is
 * `invalid symbolic mode operator`, one outside `rwx` after it is
 * `invalid symbolic mode character`.
 */
export function parseUmask(text: string, current: number): number | string {
  if (/^\d+$/.test(text)) {
    if (!/^[0-7]+$/.test(text)) return `bash: umask: ${text}: octal number out of range\n`
    return Math.min(parseInt(text, 8), 0o777)
  }
  const perms = 0o777 & ~current
  for (const clause of text.split(',')) {
    let i = 0
    while (i < clause.length && 'ugoa'.includes(clause[i] ?? '')) i++
    if (i >= clause.length || !'+-='.includes(clause[i] ?? '')) {
      const bad = i < clause.length ? (clause[i] ?? '') : ''
      return `bash: umask: \`${bad}': invalid symbolic mode operator\n`
    }
    for (const ch of clause.slice(i + 1)) {
      if (!'+-=rwx'.includes(ch)) {
        return `bash: umask: \`${ch}': invalid symbolic mode character\n`
      }
    }
  }
  const parsed = parseChmod(text, perms)
  if (parsed === null) return `bash: umask: \`${text}': invalid symbolic mode character\n`
  return 0o777 & ~parsed
}

/**
 * Print or set the session's file-creation mask. Octal by default,
 * symbolic under `-S`, re-readable under `-p`; with one operand it is
 * set for the rest of the shell (a subshell gets its own copy). Extra
 * operands are ignored, an unknown option is exit 2, a bad mode exit 1
 * with the mask unchanged.
 */
export function handleUmask(args: string[], session: SessionState): Result {
  const scan = scanOptions(args, 'Sp')
  if (scan.bad !== null)
    return fail('umask', `bash: umask: ${scan.bad}: invalid option\n${USAGE}\n`, 2)
  const symbolic = scan.letters.includes('S')
  const reusable = scan.letters.includes('p')
  const operands = scan.operands
  if (operands.length === 0) {
    let body = symbolic ? symbolicUmask(session.umask) : session.umask.toString(8).padStart(4, '0')
    if (reusable) body = `umask ${symbolic ? '-S ' : ''}${body}`
    return [
      new TextEncoder().encode(body + '\n'),
      new IOResult(),
      new ExecutionNode({ command: 'umask', exitCode: 0 }),
    ]
  }
  const parsed = parseUmask(operands[0] ?? '', session.umask)
  if (typeof parsed === 'string') return fail('umask', parsed, 1)
  session.umask = parsed
  return [null, new IOResult(), new ExecutionNode({ command: 'umask', exitCode: 0 })]
}

/** The `umask` arm. */
export function umaskBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleUmask([...call.argv.args], call.session))
}
