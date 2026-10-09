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
import { compileSpec } from './compile.ts'
import { SPECS as SPEC_TABLE } from './builtin_specs/index.ts'
import { HELP_OPTION, VERSION_OPTION } from './constants.ts'
import { CommandSpec, type Argument } from './types.ts'

export function specOf(name: string): CommandSpec {
  const spec = BUILTIN_SPECS[name]
  if (spec === undefined) throw new Error(`no builtin spec: ${name}`)
  return spec
}

// Null prototype: command names are script-controlled, so a name like
// `toString` must miss instead of resolving an `Object.prototype`
// member as a spec.
export const BUILTIN_SPECS: Readonly<Record<string, CommandSpec>> = Object.freeze(
  Object.setPrototypeOf(SPEC_TABLE, null) as Record<string, CommandSpec>,
)

/**
 * The spec plus whichever of --help / --version it does not declare.
 *
 * Mirrors GNU coreutils: every command accepts both, so both have to parse
 * before a handler can short-circuit them. A command declaring either keeps
 * its own. `help_spec` in builtin_specs/__init__.py is the twin.
 */
export function helpSpec(spec: CommandSpec): CommandSpec {
  const extras: Argument[] = []
  if (!compileSpec(spec).options.some((o) => o.names.includes('--help'))) extras.push(HELP_OPTION)
  if (!compileSpec(spec).options.some((o) => o.names.includes('--version')))
    extras.push(VERSION_OPTION)
  if (extras.length === 0) return spec
  // Instance spread mirrors Python's dataclasses.replace: every CommandSpec
  // field rides along, including ones added after this code was written.
  // The prototype loss the lint warns about is the point: init wants a plain
  // field bag, and the constructor rebuilds the class.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return new CommandSpec({ ...spec, arguments: [...spec.arguments, ...extras] })
}

// The builtin specs in the form the registry actually parses. Built once so
// there is ONE enriched object per builtin rather than one per backend that
// registers the command, which is what makes the identity test below a
// pointer compare instead of a field-by-field probe.
export const BUILTIN_HELP_SPECS: Readonly<Record<string, CommandSpec>> = Object.freeze(
  Object.setPrototypeOf(
    Object.fromEntries(Object.entries(BUILTIN_SPECS).map(([n, s]) => [n, helpSpec(s)])),
    null,
  ) as Record<string, CommandSpec>,
)

/**
 * The spec the registry parses for this command.
 *
 * `helpSpec`, except that a builtin gets the one shared copy rather than a
 * fresh one per registration, so `isBuiltinGrammar` can answer with a pointer
 * compare. `registered_spec` in builtin_specs/__init__.py is the twin.
 */
export function registeredSpec(name: string, spec: CommandSpec): CommandSpec {
  const shared = BUILTIN_HELP_SPECS[name]
  if (shared !== undefined && spec === BUILTIN_SPECS[name]) return shared
  return helpSpec(spec)
}

/**
 * Whether `spec` is the builtin `name`'s own grammar.
 *
 * The measured per-program rules (NO_LONG_OPTIONS,
 * SOLE_ARGUMENT_LONG_OPTIONS, DIGIT_OPTIONS, LONG_SYNONYMS, IN_ORDER_OPERANDS,
 * LETTER_OPTIONS) describe one real program, so a mount that
 * registers its own command under a builtin's name must not inherit them:
 * nothing refuses that registration, and `expr` is the sharp case, where the
 * rule turns a declared `--mode=x` into an operand its handler then never
 * sees.
 *
 * A name is not an identity, and neither is the declared spec on its own:
 * the registry parses an enriched COPY (config.ts appends the two standard
 * options), so both forms count and both are compared by object.
 * `is_builtin_grammar` in builtin_specs/__init__.py is the twin.
 */
export function isBuiltinGrammar(name: string, spec: CommandSpec | null): boolean {
  if (spec === null) return false
  return spec === BUILTIN_SPECS[name] || spec === BUILTIN_HELP_SPECS[name]
}
