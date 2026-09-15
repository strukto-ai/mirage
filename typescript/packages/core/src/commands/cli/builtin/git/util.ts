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

import type { CommandFnResult } from '../../../config.ts'
import { HEAD } from './constants.ts'
import type { FlagView } from '../../../spec/types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { GitError } from './errors.ts'
import type { CLIInvocation } from '../../types.ts'
import { UnrecognizedArgumentError } from './errors.ts'

const ROOT = '/'
// The end-of-options marker, which the parser consumes.
const MARKER = '--'

const ENC = new TextEncoder()

/**
 * Where repository discovery begins for this invocation.
 *
 * `-C` changes directory before anything else happens, git's own reading of the
 * option. It needs no separate session-cwd fact: the option is declared with a
 * `'.'` default, and a PATH default lands as if typed, so an absent `-C`
 * resolves to the session cwd and a relative `-C build` is already absolute by
 * the time it arrives.
 *
 * Read as a string, not a PathSpec: group-level values are resolved by the walk
 * and reach a leaf as absolute virtual paths, while a leaf's own PATH flags are
 * recovered as PathSpec by parseFlags.
 *
 * @param fl spec-validated view over the leaf's flag bag
 */
export function startPoint(fl: FlagView): string {
  return fl.asStr('C') ?? ROOT
}

/**
 * The revision operand a verb was given, or git's own default.
 *
 * @param texts positional text operands
 * @param fallback what an absent operand means
 */
export function revisionArg(texts: readonly string[], fallback: string = HEAD): string {
  return texts[0] ?? fallback
}

/**
 * The words a `--` on the line marked as operands, not options.
 *
 * `--` is exactly how a caller names a file whose name begins with a dash, and
 * git says so in every synopsis that ends `[--] [<pathspec>...]`: `git rm
 * -draft` is a refused switch and `git rm -- -draft` removes the file. The
 * parser consumes the marker, so the words themselves are what carries the fact
 * forward, read back off the verbatim argv the record already holds.
 *
 * A set is enough. A dash word before the marker was read as an option and
 * never reached the operands, so a word that is here and also spelled earlier on
 * the line is still the escaped one.
 *
 * @param argv the line's verbatim tokens after the head word, subcommand words
 *   included
 */
export function escaped(argv: readonly string[]): Set<string> {
  const at = argv.indexOf(MARKER)
  return at === -1 ? new Set() : new Set(argv.slice(at + 1))
}

/**
 * Refuse an operand that is really an option this build lacks.
 *
 * A verb taking a revision accepts free text, so every flag mirage does not
 * declare reaches it as one. Resolving it as a revision is the wrong answer
 * twice over: it fails, and it fails saying the repository has no such commit,
 * when what happened is that mirage has no such flag. Refused here, before any
 * object is read, so the message names the real problem.
 *
 * Unless the caller said otherwise. A word after `--` is an operand by the
 * caller's own instruction whatever it starts with, so it is never read as an
 * option here; see `escaped`, which is where the marker survives the parser.
 *
 * Which side of the marker an operand fell on says nothing about what it
 * *means*: a verb taking a revision reads an escaped word as one and fails with
 * git's own "unknown revision or path" wording, where git would narrow the walk
 * by it instead. That divergence is unchanged and deliberate, because limiting
 * by nothing would print every commit and look like an answer.
 *
 * Which refusal to raise is the caller's, because git words this differently per
 * verb and means each one: see UnknownSwitchError for the three.
 *
 * @param texts positional text operands, as typed
 * @param error the refusal this verb words it with
 * @param marked operands a `--` on the line escaped
 * @param known the verb's one-letter switches, which narrow a refused cluster to
 *   its first unknown letter the way parse-options does; absent refuses the
 *   whole word
 */
export function checkOperands(
  texts: readonly string[],
  error: new (argument: string) => GitError = UnrecognizedArgumentError,
  marked: ReadonlySet<string> = new Set(),
  known?: ReadonlySet<string>,
): void {
  for (const text of texts) {
    if (text.startsWith('-') && !marked.has(text)) throw new error(offendingSwitch(text, known))
  }
}

/**
 * The one-letter switches the leaf declares, without their dash.
 *
 * Read off the spec the line was parsed against, so the set is the verb's
 * own and never a copy of it; empty where no executor built the record.
 *
 * @param inv the invocation, carrying its leaf
 */
export function switches(inv: CLIInvocation): ReadonlySet<string> {
  const letters = new Set<string>()
  for (const option of inv.spec?.options ?? []) {
    if (option.short !== null && option.short.length === 2) letters.add(option.short.slice(1))
  }
  return letters
}

/**
 * The part of a dash word parse-options would refuse.
 *
 * git reads a short cluster letter by letter, consumes the ones the verb
 * declares and stops at the first it does not, so `git mv -nx` says `x' and
 * `git mv -draft` says `d' (git 2.50.1); a verb that declares no switch at
 * all (`reset`) still names the first letter. A long option is refused as
 * typed, and so is a cluster for a verb that hands over no set: log, show
 * and diff word the whole argument.
 *
 * @param text the dash word as the user spelled it
 * @param known the verb's one-letter switches, absent for a verb that
 *   refuses the word whole
 */
export function offendingSwitch(text: string, known: ReadonlySet<string> | undefined): string {
  if (known === undefined || text.startsWith('--')) return text
  for (const letter of text.slice(1)) {
    if (!known.has(letter)) return `-${letter}`
  }
  return text
}

/**
 * Render a git error: `<prefix>: <message>`, on its own stream.
 *
 * git uses 128 for a fatal, which is neither the dispatcher's usage exit (2) nor
 * its generic handler-error exit (1), so leaves return the code rather than
 * throwing into the catch-all. A refused option carries its own prefix and code
 * instead, which is git's own split, and a refusal that is really a report
 * ("nothing to commit") carries no prefix and goes to stdout.
 *
 *
 * An error carrying a `report` puts that on stdout beside the stderr line,
 * because git writes some refusals to both streams at once: `<path>: needs
 * merge` is the diagnosis and "you need to resolve your current index first" is
 * the refusal.
 *
 * @param exc the error to render
 */
export function fatal(exc: GitError): CommandFnResult {
  const body = exc.prefix === null ? `${exc.message}\n` : `${exc.prefix}: ${exc.message}\n`
  const data = ENC.encode(body)
  if (exc.stream === 'stdout') return [data, new IOResult({ exitCode: exc.code })]
  const told = exc.report === '' ? null : ENC.encode(exc.report)
  return [told, new IOResult({ exitCode: exc.code, stderr: data })]
}
