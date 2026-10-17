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

import { VERSION } from '../../version.ts'
import { ROOT_CWD } from '../constants.ts'
import { isBuiltinGrammar, registeredSpec } from './builtins.ts'
import {
  EXTRA_STANDARD,
  HELP_OPTION,
  SHORT_STANDARD,
  STANDARD_AFTER_SCAN,
  STANDARD_BEFORE_SCAN,
  STANDARD_LAST_WINS,
  VERSION_OPTION,
} from './constants.ts'
import { FlagView } from './flag_view.ts'
import { renderHelp } from './help.ts'
import { type ParsedArgs, parseCommand, parseToKwargs } from './parser.ts'
import { SYNOPSES } from './synopsis.ts'
import { type CommandSpec, UsageStyle } from './types.ts'

const ENC = new TextEncoder()

/** The `--version` answer of a command. */
export function versionLine(name: string): string {
  return `${name} (Mirage) ${VERSION}\n`
}

/** The `--pcre2-version` answer: mirage translates PCRE2 patterns and has no JIT. */
export function pcre2Line(): string {
  return `PCRE2 (Mirage) ${VERSION} is available (JIT is unavailable)\n`
}

/**
 * The `--help` page of a command.
 *
 * The page lists `--help` and `--version` as well. Only the builtin itself
 * gets GNU's synopsis line; a mount command that borrows the name keeps the
 * line its own spec renders.
 */
export function helpPage(name: string, spec: CommandSpec): string {
  const synopsis = isBuiltinGrammar(name, spec) ? SYNOPSES[name] : undefined
  return renderHelp(name, registeredSpec(name, spec), [], UsageStyle.ARGPARSE, synopsis)
}

/** Whether the registration answers `--help` for this spec. */
export function hasInjectedHelp(spec: CommandSpec | null): boolean {
  return spec?.arguments.some((o) => o === HELP_OPTION) ?? false
}

/** Whether the registration answers `--version` for this spec. */
export function hasInjectedVersion(spec: CommandSpec | null): boolean {
  return spec?.arguments.some((o) => o === VERSION_OPTION) ?? false
}

function parse(name: string, spec: CommandSpec, words: string[]): ParsedArgs {
  return parseCommand(spec, words, ROOT_CWD.virtual, name)
}

function hasOptionError(parsed: ParsedArgs): boolean {
  return parsed.optionErrorKinds.length > 0 || parsed.oldOptionNeedsValue !== null
}

function answer(name: string, spec: CommandSpec, option: string): Uint8Array {
  if (option === '--help') return ENC.encode(helpPage(name, spec))
  return ENC.encode(option === '--pcre2-version' ? pcre2Line() : versionLine(name))
}

/**
 * The standard option a STANDARD_AFTER_SCAN program answers once its loop is
 * done: the last one read, or the version over the help page. Mirrors
 * Python's `_loop_answer`.
 */
function loopAnswer(
  name: string,
  spec: CommandSpec,
  whole: ParsedArgs,
  offered: string[],
  shorts: Readonly<Record<string, string>>,
): string | null {
  const keys = new Map(
    offered.map((option) => [option.replace(/^-+/, '').replaceAll('-', '_'), option]),
  )
  const fl = new FlagView(parseToKwargs(whole), spec)
  const typed: string[] = []
  for (const [key, value] of fl.occurrences(...keys.keys())) {
    const option = keys.get(key)
    if (option !== undefined && value === true) typed.push(shorts[option] ?? option)
  }
  if (typed.length === 0) return null
  if (STANDARD_LAST_WINS.has(name)) return typed.at(-1) ?? null
  return typed.includes('--version') ? '--version' : (typed[0] ?? null)
}

/**
 * The index of the first word the parser reads as `option`.
 *
 * Parsing growing prefixes of the line, instead of looking for the spelling,
 * leaves `--`, a remainder operand and an option's value to the parser:
 * `sort -o --version --version` writes to a file named `--version` and
 * answers the second one.
 */
function position(name: string, spec: CommandSpec, argv: string[], option: string): number | null {
  for (let index = 0; index < argv.length; index++) {
    if (parse(name, spec, argv.slice(0, index + 1)).typedDests.includes(option)) return index
  }
  return null
}

/**
 * The `--help` page or version line that `argv` asks for, or null to run the
 * command as usual.
 *
 * The executor asks before routing, since neither answer belongs to a
 * backend: `rm --version /ro/x` must not meet the read-only refusal, and
 * `mv --help /ram/a /disk/b` must not move the file. The rules are GNU's
 * getopt loop (coreutils 9.7):
 *
 * - the standard option the parser reaches first answers, so
 *   `cat --help --version` prints the help page;
 * - an option error ahead of it wins, so `cat --bogus --version` is a usage
 *   error, while `cat --version --bogus` prints the version;
 * - a word counts only if the parser reads it as the option, so
 *   `grep -e --version` searches for `--version`.
 *
 * Builtins in STANDARD_BEFORE_SCAN answer ahead of every option, and those in
 * STANDARD_AFTER_SCAN only when the whole line parses, with the option
 * `loopAnswer` picks. ripgrep's --pcre2-version is one of its standard
 * options (EXTRA_STANDARD).
 */
export function standardRequest(
  name: string,
  spec: CommandSpec | null,
  argv: string[],
): Uint8Array | null {
  if (spec === null) return null
  const offered: string[] = []
  if (hasInjectedHelp(spec)) offered.push('--help')
  if (hasInjectedVersion(spec)) offered.push('--version')
  const builtin = isBuiltinGrammar(name, spec)
  const shorts = builtin ? (SHORT_STANDARD[name] ?? {}) : {}
  for (const [short, long] of Object.entries(shorts))
    if (offered.includes(long)) offered.push(short)
  if (builtin) offered.push(...(EXTRA_STANDARD[name] ?? []))
  if (offered.length === 0) return null
  const whole = parse(name, spec, argv)
  if (builtin && STANDARD_AFTER_SCAN.has(name)) {
    if (hasOptionError(whole)) return null
    const option = loopAnswer(name, spec, whole, offered, shorts)
    return option === null ? null : answer(name, spec, option)
  }
  let first: { index: number; option: string } | null = null
  for (const option of offered) {
    if (!whole.typedDests.includes(option)) continue
    const index = position(name, spec, argv, option)
    if (index !== null && (first === null || index < first.index)) first = { index, option }
  }
  if (first === null) return null
  if (
    !(builtin && STANDARD_BEFORE_SCAN.has(name)) &&
    hasOptionError(parse(name, spec, argv.slice(0, first.index)))
  ) {
    return null
  }
  return answer(name, spec, shorts[first.option] ?? first.option)
}
