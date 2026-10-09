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

import { quoteText } from '../../../../commands/quote.ts'
import { usageHint } from '../../../../commands/spec/usage.ts'
import { isProgramInvocation } from '../../../../context/session_context.ts'
import { concat } from '../../../../io/cachable_iterator.ts'
import { yieldBytes } from '../../../../io/stream.ts'
import { IOResult } from '../../../../io/types.ts'
import type { SessionView } from '../../../../view/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import { ArithError } from '../../../../shell/errors.ts'
import { assignElement } from '../../../session/elements.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { runPrintf } from './format.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { envSnapshot, sessionView } from '../../../session/state.ts'
import { TARGET_RE } from '../constants.ts'

// bash 5.2.21's own string, which both the usage error and the invalid-option
// refusal end with.
const USAGE = 'printf: usage: printf [-v var] format [arguments]\n'

// bash's own help page for the printf builtin, byte for byte as bash 5.2.37
// writes it, because `printf --help` is answered by the builtin and a
// builtin's page is bash's, not GNU coreutils'. It cannot come from
// renderHelp: the page documents `-v`, which is the BUILTIN's option alone
// (run as a program through `find -exec printf`, `-v` is not available), so
// CommandSpec must not declare it and the spec-driven renderer has nothing to
// render it from.
//
// One deliberate divergence, and it is a subtraction: bash lists `%Q` and
// `%(fmt)T` among the conversions it adds to printf(1), and mirage implements
// neither, so those two entries are dropped rather than promised. Everything
// mirage does implement is described in bash's own words. Adding either
// conversion means adding its lines back here. `_HELP` in printf.py is the
// twin.
export const HELP =
  'printf: printf [-v var] format [arguments]\n' +
  '    Formats and prints ARGUMENTS under control of the FORMAT.\n' +
  '    \n' +
  '    Options:\n' +
  '      -v var\tassign the output to shell variable VAR rather than\n' +
  '    \t\tdisplay it on the standard output\n' +
  '    \n' +
  '    FORMAT is a character string which contains three types of objects: plain\n' +
  '    characters, which are simply copied to standard output; character escape\n' +
  '    sequences, which are converted and copied to the standard output; and\n' +
  '    format specifications, each of which causes printing of the next successive\n' +
  '    argument.\n' +
  '    \n' +
  '    In addition to the standard format specifications described in printf(1),\n' +
  '    printf interprets:\n' +
  '    \n' +
  '      %b\texpand backslash escape sequences in the corresponding argument\n' +
  '      %q\tquote the argument in a way that can be reused as shell input\n' +
  '    \n' +
  '    The format is re-used as necessary to consume all of the arguments.  If\n' +
  '    there are fewer arguments than the format requires,  extra format\n' +
  '    specifications behave as if a zero value or null string, as appropriate,\n' +
  '    had been supplied.\n' +
  '    \n' +
  '    Exit Status:\n' +
  '    Returns success unless an invalid option is given or a write or assignment\n' +
  '    error occurs.\n'

/**
 * Assign `value` to a `printf -v` target (scalar or `name[idx]`).
 *
 * A delegation to the one element writer: a bare name assigns element 0
 * when the name already holds an array (indexed or associative),
 * nothing mutates unless the whole assignment succeeds, and the landing
 * write goes through the session view as the whole variable, so a `preSession`
 * rule refusing the name sees `printf -v 'AWS_KEY[0]'` as a write to
 * AWS_KEY. The refusal is thrown, not collapsed into a status, so the
 * rule's own words reach the user as they do from `export`. bash stores the
 * bytes the format produced, so a `\x` run that is valid UTF-8 is stored as
 * its characters, and up to the first NUL, which no variable holds
 * (`printf -v n '1\0002'` stores 1).
 */
async function assignPrintfTarget(
  session: SessionState,
  view: SessionView | undefined,
  name: string,
  subscript: string | undefined,
  value: string,
): Promise<'ok' | 'denied' | 'readonly' | 'subscript'> {
  const text = decodeText(encodeText(value)).split('\0', 1)[0] ?? ''
  return assignElement(session, view ?? null, name, subscript ?? null, text)
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
 * printf) the word is the format, and a format that takes no argument
 * warns about the ones it drops.
 */
export async function handlePrintf(
  args: string[],
  session: SessionState,
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
      const err = encodeText(`bash: printf: \`${target}': not a valid identifier\n`)
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
      ]
    }
  }
  const first = args[0]
  if (first !== undefined && !isProgramInvocation(session)) {
    if (first === '--') {
      args = args.slice(1)
      if (args.length === 0) {
        // `--` ends the options and the FORMAT is still required, so the line
        // is bash's usage error rather than an empty one (bash 5.2.21:
        // `printf --` is exit 2 with the usage, where `printf -- --zzz` prints
        // `--zzz`).
        const err = encodeText(USAGE)
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
        ]
      }
    } else if (first === '--help') {
      // bash answers the EXACT word `--help` for every builtin, ahead of
      // its option scan, by writing the builtin's help page to STDOUT and
      // exiting 2 -- only a spelling the option scan actually reads (`--hel`,
      // `--version`) takes the invalid-option path below (bash 5.2.37). The
      // page is the BUILTIN's, in bash's own words and layout, because that
      // is whose printf this is; see HELP.
      const page = encodeText(HELP)
      return [
        yieldBytes(page),
        new IOResult({ exitCode: 2 }),
        new ExecutionNode({ command: 'printf', exitCode: 2 }),
      ]
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
      const err = encodeText(`bash: printf: -${first[1] ?? ''}: invalid option\n${USAGE}`)
      return [
        null,
        new IOResult({ exitCode: 2, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
      ]
    }
  } else if (first === '--') {
    // coreutils printf takes one leading `--` as the end of its options.
    args = args.slice(1)
  }
  if (args.length === 0 && isProgramInvocation(session)) {
    const err = encodeText(`printf: missing operand\n${usageHint('printf')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'printf', exitCode: 1, stderr: err }),
    ]
  }
  if (args.length === 0) {
    // A format is required: bash's usage error, `printf -v x` too.
    const err = encodeText(USAGE)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'printf', exitCode: 2, stderr: err }),
    ]
  }
  const program = isProgramInvocation(session)
  const [output, rawMessages, failed, excess] = runPrintf(
    args[0] ?? '',
    args.slice(1),
    program,
    program && Object.hasOwn(envSnapshot(session), 'POSIXLY_CORRECT'),
  )
  const voice = isProgramInvocation(session) ? '' : 'bash: '
  const messages = rawMessages.map((message) => voice + message)
  const errBytes = messages.length > 0 ? encodeText(messages.join('')) : null
  const exitCode = failed ? 1 : 0
  if (target !== null && parsed !== null) {
    const base = parsed[1] ?? ''
    let status: 'ok' | 'denied' | 'readonly' | 'subscript'
    try {
      status = await assignPrintfTarget(session, view, base, parsed[2], output)
    } catch (err) {
      if (err instanceof ArithError) {
        // The target carries `-i` and the formatted text does not
        // evaluate, which ends the shell as any `-i` value does.
        const signal = err.signal('printf', true)
        signal.stderr = concat([encodeText(messages.join('')), signal.stderr])
        throw signal
      }
      if (!(err instanceof PolicyDenied)) throw err
      const denied = encodeText(messages.join('') + `bash: ${err.message}\n`)
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
      const err = encodeText(messages.join('') + detail)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'printf', exitCode: 1, stderr: err }),
      ]
    }
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
  // coreutils printf names the first argument a format that takes none
  // left over, where bash's builtin drops them silently; a warning, so the
  // status stays the format's own.
  const warning =
    excess !== null && isProgramInvocation(session)
      ? `printf: warning: ignoring excess arguments, starting with '${quoteText(excess)}'\n`
      : ''
  const text = messages.join('') + warning
  if (text !== '') {
    const stderr = encodeText(text)
    return [
      out,
      new IOResult({ exitCode, stderr }),
      new ExecutionNode({ command: 'printf', exitCode, stderr }),
    ]
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'printf', exitCode: 0 })]
}

/** The `printf` arm. */
export async function printfBuiltin(call: BuiltinCall): Promise<Result> {
  return handlePrintf(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
  )
}
