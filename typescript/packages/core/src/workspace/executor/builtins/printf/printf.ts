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

import { isProgramInvocation } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { ArithError } from '../../../../shell/errors.ts'
import { assignElement } from '../../../session/elements.ts'
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { runPrintf } from './format.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'
import { TARGET_RE } from '../constants.ts'

/**
 * Assign `value` to a `printf -v` target (scalar or `name[idx]`).
 *
 * A delegation to the one element writer: a bare name assigns element 0
 * when the name already holds an array (indexed or associative),
 * nothing mutates unless the whole assignment succeeds, and the landing
 * write goes through the door as the whole variable, so a `preSession`
 * rule refusing the name sees `printf -v 'AWS_KEY[0]'` as a write to
 * AWS_KEY. The refusal is thrown, not collapsed into a status, so the
 * rule's own words reach the user as they do from `export`.
 */
async function assignPrintfTarget(
  session: Session,
  view: SessionView | undefined,
  name: string,
  subscript: string | undefined,
  value: string,
): Promise<'ok' | 'denied' | 'readonly' | 'subscript'> {
  return assignElement(session, view ?? null, name, subscript ?? null, value)
}

/**
 * Print formatted output, honoring GNU printf's format-reuse rules.
 *
 * Supports `%s %c %b %q`, the integer conversions `%d %i %o %u %x %X`,
 * the float conversions `%f %F %e %E %g %G %a %A`, and `%%`, with
 * `- + 0 # (space)` flags, numeric or `*` width/precision, and backslash
 * escapes (including `\u`/`\U`) interpreted once in the same scan. When
 * arguments remain after one pass the format is reused until they are
 * exhausted; a missing argument renders as the empty string / `0`.
 * Integers wrap at 64 bits; `%a` formats at IEEE double precision. The
 * conversion engine itself lives in `format.ts`.
 *
 * With `-v NAME` the formatted text is stored in the shell variable
 * `NAME` (or the array element `NAME[idx]`) instead of written to
 * stdout, matching bash's builtin. An unusable `NAME` is rejected before
 * the format runs (status 2); a readonly name or an out-of-range subscript
 * still reports the format's own errors first, then fails with status 1
 * and leaves the variable untouched. `-v` is the builtin's alone: run as a
 * program (`find -exec printf`, which execvp answers with coreutils
 * printf) the word is the format.
 */
export async function handlePrintf(
  args: string[],
  session: Session,
  view?: SessionView,
): Promise<Result> {
  let target: string | null = null
  let parsed: RegExpExecArray | null = null
  if (args.length >= 2 && args[0] === '-v' && !isProgramInvocation(session)) {
    target = args[1] ?? ''
    args = args.slice(2)
    parsed = TARGET_RE.exec(target)
    if (parsed === null) {
      // bash validates the name before formatting, so a bad name
      // suppresses the conversion errors the format would report.
      const err = new TextEncoder().encode(`printf: \`${target}': not a valid identifier\n`)
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
      ]
    }
  }
  if (args.length === 0) {
    if (target !== null) {
      const err = new TextEncoder().encode('printf: usage: printf [-v var] format [arguments]\n')
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
      ]
    }
    return [new Uint8Array(), new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
  }
  const [output, errors] = runPrintf(args[0] ?? '', args.slice(1))
  const errBytes = errors.length > 0 ? new TextEncoder().encode(errors.join('')) : null
  if (target !== null && parsed !== null) {
    const base = parsed[1] ?? ''
    let status: 'ok' | 'denied' | 'readonly' | 'subscript'
    try {
      status = await assignPrintfTarget(session, view, base, parsed[2], output)
    } catch (err) {
      if (err instanceof ArithError) {
        // The target carries `-i` and the formatted text does not
        // evaluate; bash voices the evaluator after the builtin name.
        const bad = new TextEncoder().encode(errors.join('') + `bash: printf: ${err.message}\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: bad }),
          new ExecutionNode({ command: 'printf', exitCode: 1, stderr: bad }),
        ]
      }
      if (!(err instanceof PolicyDenied)) throw err
      const denied = new TextEncoder().encode(errors.join('') + `bash: ${err.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: denied }),
        new ExecutionNode({ command: 'printf', exitCode: 1, stderr: denied }),
      ]
    }
    if (status !== 'ok') {
      const detail =
        status === 'readonly'
          ? `bash: ${base}: readonly variable\n`
          : status === 'denied'
            ? `bash: ${base}: permission denied\n`
            : `bash: ${target}: bad array subscript\n`
      const err = new TextEncoder().encode(errors.join('') + detail)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 1, stderr: err }),
      ]
    }
    const exitCode = errors.length > 0 ? 1 : 0
    if (errBytes !== null) {
      return [
        null,
        new IOResult({ exitCode, stderr: errBytes }),
        new ExecutionNode({ command: 'printf', exitCode, stderr: errBytes }),
      ]
    }
    return [null, new IOResult({ exitCode }), new ExecutionNode({ command: 'printf', exitCode })]
  }
  const out = encodeText(output)
  if (errBytes !== null) {
    return [
      out,
      new IOResult({ exitCode: 1, stderr: errBytes }),
      new ExecutionNode({ command: 'printf', exitCode: 1, stderr: errBytes }),
    ]
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
}

/** The `printf` arm. */
export async function printfBuiltin(call: BuiltinCall): Promise<Result> {
  return handlePrintf(
    [...call.argv.args],
    call.session,
    sessionView(call.session, call.registry.policies),
  )
}
