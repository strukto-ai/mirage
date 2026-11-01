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

import { usageHint } from '../../../../commands/spec/usage.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { isProgramInvocation } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { decodeText, encodeText, utf8Locale } from '../../../../shell/bytes.ts'
import { ArithError } from '../../../../shell/errors.ts'
import { concat } from '../../../../utils/bytes.ts'
import type { SessionView } from '../../../../view/types.ts'
import { assignElement } from '../../../session/elements.ts'
import type { SessionState } from '../../../session/session.ts'
import { envSnapshot, sessionView } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { TARGET_RE } from '../constants.ts'
import { builtinUsage, fail, result } from '../shared.ts'
import type { BuiltinCall } from '../types.ts'
import { printfOutput, runPrintf } from './format.ts'

/**
 * Print formatted output, honoring GNU printf's format-reuse rules.
 *
 * Supports `%s %c %b %q`, the integer conversions `%d %i %o %u %x %X`,
 * the float conversions `%f %F %e %E %g %G %a %A`, and `%%`, with
 * `- + 0 # (space)` flags, numeric or `*` width/precision, and backslash
 * escapes (including `\u`/`\U`) interpreted once in the same scan. When
 * arguments remain after one pass the format is reused until they are
 * exhausted; a missing argument renders as the empty string / `0`.
 * Integers saturate at 64-bit limits; negative unsigned values wrap. `%a`
 * formats at IEEE double precision. The shared Rust stream owns conversions.
 *
 * With `-v NAME` the formatted text is stored in the shell variable
 * `NAME` (or the array element `NAME[idx]`) instead of written to
 * stdout, matching bash's builtin. An unusable `NAME` is rejected before
 * the format runs (status 2); a readonly name or an out-of-range subscript
 * still reports the format's own errors first, then fails with status 1
 * and leaves the variable untouched. bash stores the bytes the format
 * produced, so a `\x` run that is valid UTF-8 is stored as its characters,
 * and up to the first NUL, which no variable holds (`printf -v n '1\0002'`
 * stores 1). `-v` is the builtin's alone: run as a program (`find -exec
 * printf`, which execvp answers with coreutils printf) the word is the
 * format, and a format that takes no argument warns about the ones it
 * drops.
 */
export async function handlePrintf(
  args: string[],
  session: SessionState,
  view?: SessionView,
  signal?: AbortSignal,
): Promise<RedirectResult> {
  const program = isProgramInvocation(session)
  let target: string | null = null
  let parsed: RegExpExecArray | null = null
  if (args.length >= 2 && args[0] === '-v' && !program) {
    target = args[1] ?? ''
    args = args.slice(2)
    parsed = TARGET_RE.exec(target)
    if (parsed === null) {
      // bash validates the name before formatting, so a bad name
      // suppresses the conversion errors the format would report.
      return fail('printf', `bash: printf: \`${target}': not a valid identifier\n`, 2)
    }
  }
  const first = args[0]
  if (first !== undefined && !program) {
    if (first === '--') {
      args = args.slice(1)
      if (args.length === 0) {
        // `--` ends the options and the FORMAT is still required, so the line
        // is bash's usage error rather than an empty one (bash 5.2.21:
        // `printf --` is exit 2 with the usage, where `printf -- --zzz` prints
        // `--zzz`).
        return fail('printf', builtinUsage('printf'), 2)
      }
    } else if (first.startsWith('-') && first.length > 1 && first !== '-v') {
      // bash's option scan takes single letters only, so it reports the
      // first character it does not know spelled with ONE dash: a long
      // spelling answers for its second dash and its text never reaches the
      // message, which is why `printf --zzz`, `printf --hel` and
      // `printf --zzz=é` are all `printf: --: invalid option` (bash 5.2.21).
      // The coreutils binary is lenient here and prints the word, but mirage
      // ships printf as a builtin, so the builtin governs. A bare `-v` short
      // of its NAME is left to the format path, where bash's own `option
      // requires an argument` is a separate change.
      return fail(
        'printf',
        `bash: printf: -${first[1] ?? ''}: invalid option\n${builtinUsage('printf')}`,
        2,
      )
    }
  } else if (first === '--') {
    // coreutils printf takes one leading `--` as the end of its options.
    args = args.slice(1)
  }
  if (args.length === 0) {
    // A format is required: bash's usage error, `printf -v x` too.
    if (program) return fail('printf', `printf: missing operand\n${usageHint('printf')}\n`)
    return fail('printf', builtinUsage('printf'), 2)
  }
  const posix = program && Object.hasOwn(envSnapshot(session), 'POSIXLY_CORRECT')
  const utf8 = utf8Locale(envSnapshot(session))
  if (target === null || parsed === null) {
    return printed(args[0] ?? '', args.slice(1), program, posix, utf8, signal)
  }
  const [output, stderr, exitCode] = await runPrintf(
    args[0] ?? '',
    args.slice(1),
    program,
    posix,
    utf8,
    signal,
  )
  const errors = decodeText(stderr)
  const base = parsed[1] ?? ''
  const text = decodeText(output).split('\0', 1)[0] ?? ''
  let status: 'ok' | 'denied' | 'readonly' | 'subscript'
  try {
    status = await assignElement(session, view ?? null, base, parsed[2] ?? null, text)
  } catch (err) {
    if (err instanceof ArithError) {
      // The target carries `-i` and the formatted text does not
      // evaluate, which ends the shell as any `-i` value does.
      const signal = err.signal('printf', true)
      signal.stderr = concat([encodeText(errors), signal.stderr])
      throw signal
    }
    if (!(err instanceof PolicyDenied)) throw err
    return fail('printf', errors + `bash: ${err.message}\n`)
  }
  if (status === 'readonly') return fail('printf', errors + `bash: ${base}: readonly variable\n`)
  if (status === 'denied') return fail('printf', errors + `bash: ${base}: permission denied\n`)
  if (status !== 'ok') return fail('printf', errors + `bash: ${target}: bad array subscript\n`)
  return result('printf', { exitCode, stderr: errors })
}

/**
 * `printf` to stdout: the output streams as the engine drains it, and the
 * status and stderr settle once it ends. Mirrors Python's _printed.
 */
function printed(
  fmt: string,
  args: string[],
  program: boolean,
  posix: boolean,
  utf8: boolean,
  signal?: AbortSignal,
): RedirectResult {
  const io = new IOResult()
  const node = new ExecutionNode({ command: 'printf' })
  async function* output(): AsyncGenerator<Uint8Array> {
    try {
      yield* printfOutput(fmt, args, io, program, posix, utf8, signal)
    } finally {
      node.exitCode = io.exitCode
      node.stderr = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
    }
  }
  return [output(), io, node]
}

/** The `printf` arm. */
export async function printfBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  return handlePrintf(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
    call.signal,
  )
}
