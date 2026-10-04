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
import type { FlagView } from '../../../spec/flag_view.ts'
import { IOResult } from '../../../../io/types.ts'
import type { GitError } from './errors.ts'
import { CLISpec, type CLIInvocation } from '../../types.ts'
import { BadConfigValueError, UnrecognizedArgumentError, UsageError } from './errors.ts'
import { HELP_SWITCH, gitOptionRefusal, gitUsage } from '../../refusal.ts'

const ROOT = '/'
export const STDOUT = 'stdout'
export const STDERR = 'stderr'
// The end-of-options marker, which the parser consumes.
const MARKER = '--'
const TRUE_WORDS = ['true', 'yes', 'on']
const FALSE_WORDS = ['false', 'no', 'off', '']
// git_parse_signed: strtoimax in base 0 after C-locale space, then at most one
// unit, and the product has to fit an int.
const INTEGER = /^[ \t\n\v\f\r]*([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)$/
const UNIT_SHIFTS: Readonly<Record<string, number>> = { '': 0, k: 10, m: 20, g: 30 }
const INT_BITS = 31
const VALUE_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\t': '\\t',
  '"': '\\"',
  '\\': '\\\\',
}
const QUOTED_HEADER = /^\s*\[([A-Za-z0-9.-]+)\s+"((?:[^"\\\n]|\\.)*)"\s*\]/
const DOTTED_HEADER = /^\s*\[([A-Za-z0-9-]+)\.([^\]\s]*)\]/

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
 * The operands before a `--` on the line and the ones after it.
 *
 * `git diff A B -- docs` reads what comes before the marker as revisions and
 * what follows as pathspecs, whatever either looks like. Every word after the
 * marker is an operand, so they are the tail of the operands, as many as the
 * verbatim argv holds past it.
 *
 * @param texts positional text operands, as typed
 * @param argv the line's verbatim tokens after the head word, subcommand words
 *   included
 */
export function splitMarked(
  texts: readonly string[],
  argv: readonly string[],
): [string[], string[]] {
  const at = argv.indexOf(MARKER)
  if (at === -1) return [[...texts], []]
  const cut = texts.length - (argv.length - at - 1)
  return [texts.slice(0, cut), texts.slice(cut)]
}

/**
 * The first operand that is really an option this build lacks.
 *
 * A verb taking a revision accepts free text, so every flag mirage does not
 * declare reaches it as one. Resolving it as a revision is the wrong answer
 * twice over: it fails, and it fails saying the repository has no such commit,
 * when what happened is that mirage has no such flag. Found here, before any
 * object is read, so the refusal names the real problem.
 *
 * Unless the caller said otherwise. A word after `--` is an operand by the
 * caller's own instruction whatever it starts with, so it is never read as an
 * option here; see `escaped`, which is where the marker survives the parser.
 *
 * Which side of the marker an operand fell on says nothing about what it
 * *means* here. `diff`, `show` and `diff-tree` read what follows the marker as
 * pathspecs (`splitMarked`); a walk (`log`, `rev-list`, `shortlog`) reads an
 * escaped word as a revision and fails with git's own "unknown revision or
 * path" wording, where git would narrow the walk by it instead. That divergence
 * is deliberate, because limiting by nothing would print every commit and look
 * like an answer.
 *
 * @param texts positional text operands, as typed
 * @param marked operands a `--` on the line escaped
 * @param known the verb's one-letter switches, which narrow a refused cluster to
 *   its first unknown letter the way parse-options does; absent names the whole
 *   word
 */
export function offending(
  texts: readonly string[],
  marked: ReadonlySet<string> = new Set(),
  known?: ReadonlySet<string>,
): string | null {
  for (const text of texts) {
    if (text.startsWith('-') && !marked.has(text)) return offendingSwitch(text, known)
  }
  return null
}

/**
 * The first operand that is really an option, once `-h` is out.
 *
 * `-h` asks for the verb's usage block, which git prints on stdout for most
 * verbs and on stderr for a few (`diff`); every other word is the caller's to
 * refuse in the verb's own words. See `offending` for which words count.
 *
 * @param inv the invocation, carrying its leaf
 * @param texts positional text operands, as typed
 * @param helpStream where `-h` puts the usage block
 * @throws UsageError the line asked for the usage block
 */
export function optionOperand(
  inv: CLIInvocation,
  texts: readonly string[],
  helpStream: typeof STDOUT | typeof STDERR = STDOUT,
): string | null {
  const word = offending(texts, escaped(inv.argv))
  if (word === HELP_SWITCH) {
    const usage = verbUsage(inv)
    if (helpStream === STDOUT) throw new UsageError(usage, '')
    throw new UsageError('', usage)
  }
  return word
}

/**
 * Refuse an operand that is really an option, as an unrecognized argument.
 *
 * For the verbs git words without a usage block (`log`, `show`, `reflog`),
 * whose refusal names the whole word (git 2.50.1).
 *
 * @param inv the invocation, carrying its leaf
 * @param texts positional text operands, as typed
 */
export function checkOperands(inv: CLIInvocation, texts: readonly string[]): void {
  const word = optionOperand(inv, texts)
  if (word !== null) throw new UnrecognizedArgumentError(word)
}

/**
 * The verb's usage block, as parse-options prints it.
 *
 * @param inv the invocation, carrying its leaf
 */
export function verbUsage(inv: CLIInvocation): string {
  const spec = inv.spec ?? new CLISpec({ name: '' })
  return gitUsage(spec.name, spec)
}

/**
 * Refuse an operand that is really an option, as parse-options does.
 *
 * The verbs built on parse-options (`status`, `add`, `branch`, `commit` and
 * most others) name an unknown option or switch and follow it with the usage
 * block, refuse a boolean handed a value on one line, and print the usage block
 * on stdout for `-h`; see `gitOptionRefusal`. Measured on git 2.50.1.
 *
 * @param inv the invocation, carrying its leaf
 * @param texts positional text operands, as typed
 */
export function checkSwitches(inv: CLIInvocation, texts: readonly string[]): void {
  const word = offending(texts, escaped(inv.argv), switches(inv))
  if (word !== null) {
    const spec = inv.spec ?? new CLISpec({ name: '' })
    throw new UsageError(...gitOptionRefusal(word, spec.name, spec))
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

/**
 * A config boolean read the way git's config callbacks read one.
 *
 * Every occurrence is parsed and the last one wins, so a value git cannot read
 * fails even when a later line would have read fine. A value is
 * `true`/`yes`/`on` or `false`/`no`/`off` in any case, empty for false, or an
 * integer for whether it is nonzero (pinned against git 2.54).
 *
 * @param values every value the variable takes, in file order; a bare name
 *   arrives as `true`
 * @param key the variable, section and name lowercased
 * @param fallback the answer when the variable is unset
 */
export function gitBool(values: readonly string[], key: string, fallback: boolean): boolean {
  let answer = fallback
  for (const value of values) {
    const parsed = maybeBool(value)
    if (parsed === null) throw new BadConfigValueError(value, key)
    answer = parsed
  }
  return answer
}

/**
 * `git_parse_maybe_bool`: `true`/`yes`/`on` or `false`/`no`/`off` in any case,
 * empty for false, or an integer for whether it is nonzero; null for anything
 * else, which each caller answers in its own way.
 *
 * @param value the value as typed or as the config spells it
 */
export function maybeBool(value: string): boolean | null {
  const word = value.toLowerCase()
  if (TRUE_WORDS.includes(word)) return true
  if (FALSE_WORDS.includes(word)) return false
  const number = integer(value)
  return number === null ? null : number !== 0
}

/**
 * One `[section "name"]` block the way git's config writer spells it.
 *
 * The subsection escapes `"` and `\`; a value escapes those plus newline and
 * tab, and is quoted when it starts or ends with a space or holds `;` or `#`.
 * A branch may be named `a"b` or `a#b`, and either one written raw reads back
 * as a different name (pinned against git 2.50.1).
 *
 * @param section the section, e.g. `branch`
 * @param name the subsection, e.g. the branch name
 * @param pairs variables and values, in order
 */
export function configSection(
  section: string,
  name: string,
  pairs: readonly (readonly [string, string])[],
): string {
  const quoted = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  let text = `[${section} "${quoted}"]\n`
  for (const [key, value] of pairs) {
    let body = value.replace(/[\n\t"\\]/g, (ch) => VALUE_ESCAPES[ch] ?? ch)
    if (value.startsWith(' ') || value.endsWith(' ') || /[;#]/.test(value)) body = `"${body}"`
    text += `\t${key} = ${body}\n`
  }
  return text
}

/**
 * A config's text with every block for `section.name` taken out.
 *
 * `git branch -d` drops the deleted branch's settings this way, so a branch
 * made again under the same name starts with no upstream rather than with two.
 * A header names the block the way git's `section_name_match` reads it,
 * spelled exactly: `[branch "x"]` with its escapes, or the older `[branch.x]`.
 * `[Branch "x"]` and `[branch.X]` are left, as git leaves them, and a line
 * opening with `[` ends a block (pinned against git 2.50.1).
 *
 * A value continued onto the next line by a trailing backslash is followed, so
 * a continuation that opens with `[` is still part of the block. git 2.50.1
 * reads it as a header there and leaves the rest of the block behind, which it
 * then refuses as a bad config line; mirage keeps the file readable instead.
 *
 * @param text the config file's contents
 * @param section the section as git writes it, e.g. `branch`
 * @param name the subsection, e.g. the branch name
 */
export function withoutSection(text: string, section: string, name: string): string {
  let dropping = false
  let continued = false
  let inside = false
  return text
    .split(/(?<=\n)/)
    .filter((line) => {
      let value = line
      if (!continued) {
        let rest = line
        if (line.trimStart().startsWith('[')) {
          const quoted = QUOTED_HEADER.exec(line)
          const dotted = DOTTED_HEADER.exec(line)
          dropping =
            (quoted?.[1] === section && quoted[2]?.replace(/\\(.)/g, '$1') === name) ||
            (dotted?.[1] === section && dotted[2] === name)
          const header = quoted ?? dotted
          rest = line.slice(header ? header[0].length : line.indexOf(']') + 1)
        }
        const equals = rest.indexOf('=')
        value = equals < 0 || /^\s*[;#]/.test(rest) ? '' : rest.slice(equals + 1)
        inside = false
      }
      ;[continued, inside] = continues(value, inside)
      return !dropping
    })
    .join('')
}

/**
 * Whether a config value runs onto the next line, as git parses one.
 *
 * A backslash ending the line continues the value unless it is itself escaped
 * or sits in a comment; a comment starts at `;` or `#` outside double quotes.
 * Returns whether the value continues and whether the next line starts inside
 * quotes.
 *
 * @param value the rest of the line, from the value on
 * @param inside whether the line starts inside double quotes
 */
function continues(value: string, inside: boolean): [boolean, boolean] {
  const body = value.replace(/\r?\n$/, '')
  let quoted = inside
  for (let at = 0; at < body.length; at++) {
    const ch = body[at]
    if (ch === '\\') {
      if (at === body.length - 1) return [true, quoted]
      at++
    } else if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === ';' || ch === '#')) break
  }
  return [false, false]
}

/**
 * git_parse_int: the integer a config value spells, null for none.
 *
 * Hex after `0x` and octal after a leading zero, then an optional `k`, `m` or
 * `g`; a product outside an int is no integer.
 */
function integer(value: string): number | null {
  const match = INTEGER.exec(value)
  if (match === null) return null
  const [, sign = '', digits = '', unit = ''] = match
  const hex = /^0[xX]/.test(digits)
  const magnitude = hex
    ? parseInt(digits.slice(2), 16)
    : parseInt(digits, digits.startsWith('0') ? 8 : 10)
  const number = sign === '-' ? -magnitude : magnitude
  const factor = 2 ** (UNIT_SHIFTS[unit.toLowerCase()] ?? 0)
  const lowest = Math.floor(-(2 ** INT_BITS) / factor)
  const highest = Math.floor((2 ** INT_BITS - 1) / factor)
  if (number < lowest || number > highest) return null
  return number * factor
}
