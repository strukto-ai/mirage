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
  HELP_OPTION,
  STANDARD_AFTER_SCAN,
  STANDARD_BEFORE_SCAN,
  VERSION_OPTION,
} from './constants.ts'
import { renderHelp } from './help.ts'
import { type ParsedArgs, parseCommand } from './parser.ts'
import { SYNOPSES } from './synopsis.ts'
import { type CommandSpec, UsageStyle } from './types.ts'

const ENC = new TextEncoder()

/** The `--version` answer of a command. */
export function versionLine(name: string): string {
  return `${name} (Mirage) ${VERSION}\n`
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
  return parseCommand(spec, words, ROOT_CWD, name)
}

function hasOptionError(parsed: ParsedArgs): boolean {
  return parsed.optionErrorKinds.length > 0 || parsed.oldOptionNeedsValue !== null
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
 * STANDARD_AFTER_SCAN only when the whole line parses.
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
  if (offered.length === 0) return null
  const whole = parse(name, spec, argv)
  let first: { index: number; option: string } | null = null
  for (const option of offered) {
    if (!whole.typedDests.includes(option)) continue
    const index = position(name, spec, argv, option)
    if (index !== null && (first === null || index < first.index)) first = { index, option }
  }
  if (first === null) return null
  const builtin = isBuiltinGrammar(name, spec)
  if (!(builtin && STANDARD_BEFORE_SCAN.has(name))) {
    if (hasOptionError(parse(name, spec, argv.slice(0, first.index)))) return null
    if (builtin && STANDARD_AFTER_SCAN.has(name) && hasOptionError(whole)) return null
  }
  return ENC.encode(first.option === '--help' ? helpPage(name, spec) : versionLine(name))
}
