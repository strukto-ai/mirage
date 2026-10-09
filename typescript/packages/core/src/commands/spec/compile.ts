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
import { FLOAT_VALUE, INT_VALUE } from './constants.ts'
import { type Argument, type CommandSpec, type ValueType } from './types.ts'

/** First short and long spelling, for dialects that display each separately. */
export function optionSpellings(argument: Argument): [string | null, string | null] {
  return [
    argument.names.find((name) => !name.startsWith('--')) ?? null,
    argument.names.find((name) => name.startsWith('--')) ?? null,
  ]
}

/** Canonical option spelling, or the positional argument's name. */
export function argumentDest(argument: Argument): string {
  return argument.names.find((name) => name.startsWith('--')) ?? argument.names[0] ?? ''
}

/** Declared positional placeholder, including an explicit empty placeholder. */
export function positionalName(argument: Argument): string {
  return argument.metavar ?? argument.names[0] ?? ''
}

export function positionalRequired(argument: Argument): boolean {
  return argument.nargs !== '?' && argument.nargs !== '*' && argument.nargs !== 'REMAINDER'
}

function argumentShapes(spec: CommandSpec): {
  options: readonly Argument[]
  positional: readonly Argument[]
  rest: Argument | null
} {
  const options: Argument[] = []
  const positional: Argument[] = []
  let rest: Argument | null = null
  const seenNames = new Set<string>()
  for (const arg of spec.arguments) {
    if (
      arg.names.length === 0 ||
      arg.names.some((name) => name === '' || name === '-' || name === '--')
    ) {
      throw new Error('argument requires a name or option spelling')
    }
    const optional = arg.names[0]?.startsWith('-') ?? false
    if (arg.names.some((name) => name.startsWith('-') !== optional)) {
      throw new Error('argument cannot mix a positional name and option spellings')
    }
    if (arg.type === 'bool')
      throw new Error("argument type 'bool' is expressed with action='store_true'")
    if (typeof arg.nargs === 'number' && (!Number.isInteger(arg.nargs) || arg.nargs < 1)) {
      throw new Error('nargs must be a positive integer')
    }
    if (
      (arg.action === 'store_true' || arg.action === 'count') &&
      (arg.nargs !== null || arg.type !== 'str')
    ) {
      throw new Error('store_true and count do not take a type or nargs')
    }
    if (arg.valueTypes.length > 0 && (arg.nargs !== 2 || arg.valueTypes.join(',') !== 'str,path')) {
      throw new Error('valueTypes supports the text/path pair with nargs=2')
    }

    if (optional) {
      if (arg.nargs === '*' || arg.nargs === '+' || arg.nargs === 'REMAINDER') {
        throw new Error('option nargs must be a fixed count or ?')
      }
      if (arg.attachedOnly && arg.nargs !== '?') throw new Error('attachedOnly requires nargs ?')
      if (arg.providedBy.length > 0 || arg.textWhen.length > 0) {
        throw new Error('providedBy and textWhen require a positional argument')
      }
      options.push(arg)
    } else {
      if (arg.names.length !== 1) throw new Error('a positional argument takes exactly one name')
      const name = arg.names[0] ?? ''
      if (seenNames.has(name)) throw new Error(`duplicate positional argument '${name}'`)
      seenNames.add(name)
      if (arg.default !== null) throw new Error('positional defaults are not supported')
      if (arg.valueTypes.length > 0) throw new Error('valueTypes requires option spellings')
      if (arg.required) throw new Error('positional arity uses nargs, not required')
      if (arg.action !== 'store') throw new Error('a positional argument requires action store')
      if (arg.attachedOnly || arg.numericShorthand || arg.env !== null || !arg.shortValue) {
        throw new Error('option settings require option spellings')
      }
      if (rest !== null) throw new Error('a variadic positional argument must be last')
      if (arg.nargs === '*' || arg.nargs === '+' || arg.nargs === 'REMAINDER') rest = arg
      else
        for (let i = 0; i < (typeof arg.nargs === 'number' ? arg.nargs : 1); i++)
          positional.push(arg)
    }
  }
  return { options, positional, rest }
}

/**
 * A CommandSpec lowered into the lookup tables the parser walks.
 *
 * Built once per spec (cached) instead of rebuilt on every parseCommand
 * call. Spellings are the dashed forms as typed (`-e`, `--regexp`);
 * `dest` maps every spelling to its canonical spelling, the long form
 * when an option declares both, so the parsed flag bag holds ONE entry
 * per option regardless of which spelling appeared on the line
 * (click/argparse dest semantics). Mirrors Python's CompiledSpec.
 */
export interface CompiledSpec {
  readonly nargsByDest: ReadonlyMap<string, number>
  readonly valueTypesByDest: ReadonlyMap<string, readonly ValueType[]>
  readonly detachedOptionalSpellings: ReadonlySet<string>
  readonly options: readonly Argument[]
  readonly positional: readonly Argument[]
  readonly rest: Argument | null
  /** Short spellings parsed as bare booleans (true booleans plus
   * optional-value shorts). */
  readonly boolSpellings: ReadonlySet<string>
  /** Short spellings expecting a value, longest first so `-name` can
   * never lose an attached match to `-n`. */
  readonly valueSpellings: readonly string[]
  /** Short spellings whose value may attach to the same token
   * (`split -d10`), longest first. */
  readonly attachSpellings: readonly string[]
  /** Long spellings parsed as bare booleans (true booleans plus
   * optional-value longs). */
  readonly longBoolSpellings: ReadonlySet<string>
  /** Long spellings that require a value. */
  readonly longValueSpellings: ReadonlySet<string>
  /** Long spellings whose value only attaches via `=` (GNU optional
   * argument). */
  readonly longOptionalSpellings: ReadonlySet<string>
  /** Every long spelling in declaration order (the order GNU's ambiguity
   * refusal lists possibilities), for getopt_long prefix expansion. */
  readonly longSpellings: readonly string[]
  /** Canonical spellings of int-typed options; the parser refuses a
   * non-integer value at parse time (argparse `type=int`). */
  readonly intDests: ReadonlySet<string>
  /** Canonical spellings of float-typed options, refused the same way
   * (argparse `type=float`). */
  readonly floatDests: ReadonlySet<string>
  /** Value kind per spelling (parse-time lookup). */
  readonly kindOf: ReadonlyMap<string, ValueType>
  /** Value kind per canonical spelling, for post-parse PATH/TEXT value
   * collection. */
  readonly kindByDest: ReadonlyMap<string, ValueType>
  /** Spelling -> canonical spelling. */
  readonly dest: ReadonlyMap<string, string>
  /** Canonical spellings that accumulate repeated values into a list. */
  readonly multipleDests: ReadonlySet<string>
  /** Canonical spellings of boolean flags whose occurrences accumulate
   * into a number (click count, `-vvv`). */
  readonly countDests: ReadonlySet<string>
  /** Allowed values per canonical spelling, in declaration order (the
   * order GNU's ARGMATCH refusal lists them). */
  readonly choicesByDest: ReadonlyMap<string, readonly string[]>
  /** Canonical spellings that must appear, in declaration order; a
   * default satisfies the requirement. */
  readonly requiredDests: readonly string[]
  /** Value recorded per canonical spelling when the flag is absent from
   * the line. */
  readonly defaults: ReadonlyMap<string, string>
  readonly envByDest: ReadonlyMap<string, string>
  /** Canonical spelling fed by the `-<digits>` shorthand, when one
   * option declares it. */
  readonly numericDest: string | null
  /** Kind of the rest operand. */
  readonly restKind: ValueType | null
  // The rest operand gathers every word from the first operand on,
  // options included (Argument.nargs='REMAINDER', argparse nargs=REMAINDER).
  readonly remainder: boolean
  // Canonical spelling of the option that re-bases the path operands
  // after it (CommandSpec.operandBase, tar's -C).
  readonly baseDest: string | null

  /** Canonical spelling for a typed spelling. */
  destOf(spelling: string): string
}

const CACHE = new WeakMap<CommandSpec, CompiledSpec>()

// git's notation for an option parse-options also answers as `--no-<name>`,
// and the prefix itself.
const NEGATABLE = '[no-]'
const NO = 'no-'

/** Lower a CommandSpec into parser lookup tables, cached per spec. */
export function compileSpec(spec: CommandSpec): CompiledSpec {
  const cached = CACHE.get(spec)
  if (cached !== undefined) return cached

  const grammar = argumentShapes(spec)
  const nargsByDest = new Map<string, number>()
  const valueTypesByDest = new Map<string, readonly ValueType[]>()
  const detachedOptionalSpellings = new Set<string>()
  const seenSpellings = new Set<string>()
  const boolSpellings = new Set<string>()
  const valueSpellings: string[] = []
  const attachSpellings: string[] = []
  const longBoolSpellings = new Set<string>()
  const longValueSpellings = new Set<string>()
  const longOptionalSpellings = new Set<string>()
  const longSpellings: string[] = []
  const intDests = new Set<string>()
  const floatDests = new Set<string>()
  const kindOf = new Map<string, ValueType>()
  const kindByDest = new Map<string, ValueType>()
  const dest = new Map<string, string>()
  const multipleDests = new Set<string>()
  const countDests = new Set<string>()
  const choicesByDest = new Map<string, readonly string[]>()
  const requiredDests: string[] = []
  const defaults = new Map<string, string>()
  const envByDest = new Map<string, string>()
  let numericDest: string | null = null

  for (const opt of grammar.options) {
    const canonical = argumentDest(opt)
    for (const spelling of opt.names) {
      if (seenSpellings.has(spelling)) {
        throw new Error(`duplicate option spelling '${spelling}'`)
      }
      seenSpellings.add(spelling)
    }
    const arg = opt
    const width = typeof arg.nargs === 'number' ? arg.nargs : 1
    if (typeof arg.nargs === 'number') {
      if (arg.action === 'append') throw new Error('multi-value arguments use store or extend')
      nargsByDest.set(canonical, width)
      valueTypesByDest.set(
        canonical,
        arg.valueTypes.length > 0 ? arg.valueTypes : Array<ValueType>(width).fill(arg.type),
      )
    }
    if (arg.nargs === '?' && !arg.attachedOnly) {
      for (const spelling of arg.names) detachedOptionalSpellings.add(spelling)
    }
    if (
      (opt.action === 'store_true' || opt.action === 'count') &&
      (opt.choices.length > 0 || opt.default !== null)
    ) {
      throw new Error(`option '${canonical}': choices and default require a value flag`)
    }
    if (opt.choices.length > 0 && opt.default !== null && !opt.choices.includes(opt.default)) {
      throw new Error(`option '${canonical}': default '${opt.default}' is not one of its choices`)
    }
    if (opt.type === 'int') {
      if (opt.default !== null && !INT_VALUE.test(opt.default)) {
        throw new Error(`option '${canonical}': default '${opt.default}' is not an integer`)
      }
      intDests.add(canonical)
    }
    if (opt.type === 'float') {
      if (opt.default !== null && !FLOAT_VALUE.test(opt.default)) {
        throw new Error(`option '${canonical}': default '${opt.default}' is not a number`)
      }
      floatDests.add(canonical)
    }
    for (const spelling of arg.names) dest.set(spelling, canonical)
    if (opt.action !== 'store_true' && opt.action !== 'count') kindByDest.set(canonical, opt.type)
    if (opt.action === 'append' || opt.action === 'extend') multipleDests.add(canonical)
    if (opt.action === 'count') countDests.add(canonical)
    if (opt.choices.length > 0) choicesByDest.set(canonical, opt.choices)
    if (opt.required) requiredDests.push(canonical)
    if (opt.default !== null) defaults.set(canonical, opt.default)
    if (opt.env !== null) envByDest.set(canonical, opt.env)

    for (const short of arg.names.filter((name) => !name.startsWith('--'))) {
      if (opt.action === 'store_true' || opt.action === 'count') {
        boolSpellings.add(short)
      } else if (opt.nargs === '?') {
        // GNU optional argument: the bare short is boolean and a value
        // only rides attached to the same token.
        boolSpellings.add(short)
        if (opt.shortValue) attachSpellings.push(short)
        kindOf.set(short, opt.type)
      } else {
        valueSpellings.push(short)
        kindOf.set(short, opt.type)
        if (opt.numericShorthand) numericDest = canonical
      }
    }
    for (const long of arg.names.filter((name) => name.startsWith('--'))) {
      longSpellings.push(long)
      if (opt.action === 'store_true' || opt.action === 'count') {
        longBoolSpellings.add(long)
      } else if (opt.nargs === '?') {
        // GNU optional argument: bare form is boolean, value only
        // attaches via `=`; a detached next token is an operand.
        longBoolSpellings.add(long)
        longOptionalSpellings.add(long)
        kindOf.set(long, opt.type)
      } else {
        longValueSpellings.add(long)
        kindOf.set(long, opt.type)
      }
    }
  }

  for (const operand of [...grammar.positional, ...(grammar.rest === null ? [] : [grammar.rest])]) {
    const argument = operand
    const name = argument.names[0] ?? ''
    if (argument.type === 'int') intDests.add(name)
    if (argument.type === 'float') floatDests.add(name)
    if (argument.choices.length > 0) choicesByDest.set(name, argument.choices)
  }

  let baseDest: string | null = null
  if (spec.operandBase !== null) {
    baseDest = dest.get(spec.operandBase) ?? null
    if (baseDest === null) {
      throw new Error(`operandBase '${spec.operandBase}' is not a declared option`)
    }
    if (kindByDest.get(baseDest) !== 'path' || nargsByDest.has(baseDest)) {
      throw new Error(`operandBase '${spec.operandBase}' must be a single-token path option`)
    }
  }

  // Longest first so an attached match can never be stolen by a shorter
  // spelling that happens to prefix it (-name vs -n).
  valueSpellings.sort((a, b) => b.length - a.length)
  attachSpellings.sort((a, b) => b.length - a.length)

  const compiled: CompiledSpec = {
    ...grammar,
    nargsByDest,
    valueTypesByDest,
    detachedOptionalSpellings,
    boolSpellings,
    valueSpellings,
    attachSpellings,
    longBoolSpellings,
    longValueSpellings,
    longOptionalSpellings,
    longSpellings,
    intDests,
    floatDests,
    kindOf,
    kindByDest,
    dest,
    multipleDests,
    countDests,
    choicesByDest,
    requiredDests,
    defaults,
    envByDest,
    numericDest,
    restKind: grammar.rest !== null ? grammar.rest.type : null,
    baseDest,
    remainder: grammar.rest?.nargs === 'REMAINDER',
    destOf(spelling: string): string {
      return dest.get(spelling) ?? spelling
    },
  }
  CACHE.set(spec, compiled)
  return compiled
}

/**
 * getopt_long prefix matching for a long spelling.
 *
 * An exact declared spelling always wins (GNU: `--binary` never trips
 * over `--binary-files`); otherwise the candidates are every declared
 * long the typed spelling prefixes. Two declared options are two options,
 * so a prefix of both is ambiguous (`ls --re` is `--reverse` or
 * `--recursive`), unless `synonyms` (from LONG_SYNONYMS) names them one
 * option under two names, the way glibc treats several table entries
 * sharing one `val` (`grep --colo` resolves despite `--color`/`--colour`
 * being separate entries); then the prefix resolves to the first. The
 * result length tells the caller everything: 0 unknown, 1 match, 2+
 * ambiguous (every matching spelling in declaration order, the order GNU
 * lists possibilities, synonyms included like GNU's own listing).
 */
/**
 * git's parse-options resolution of one long option against the program's own
 * table, which lists each option in git's `--[no-]` notation.
 *
 * An exact name wins at once, a negatable option answering to its `--no-`
 * form too. Otherwise the word may abbreviate one option, `--no-` abbreviating
 * a negation, and a word that abbreviates two is ambiguous: git names the last
 * two it found, each with the `no-` it was matched under. A word matching
 * nothing is null, and the caller decides what that is. The result is the
 * spelling the table resolves to, which the spec may or may not declare.
 *
 * @param table the program's long options, e.g. `['[no-]verbose', 'contains']`
 * @param typed the word as typed, `--` included and any `=value` removed
 */
export function expandGitLong(
  table: readonly string[],
  typed: string,
): { spelling: string } | { ambiguous: [string, string] } | null {
  const arg = typed.slice(2)
  let found: [string, boolean] | null = null
  let earlier: [string, boolean] | null = null
  for (const entry of table) {
    const negatable = entry.startsWith(NEGATABLE)
    const long = negatable ? entry.slice(NEGATABLE.length) : entry
    const inverted = !arg.startsWith(NO) && negatable && long.startsWith(NO)
    const name = inverted ? long.slice(NO.length) : long
    let unset = false
    let exact = arg === name
    let abbreviated = !exact && name.startsWith(arg)
    if (!exact && !abbreviated && negatable) {
      if (NO.startsWith(arg)) {
        unset = true
        abbreviated = true
      } else if (arg.startsWith(NO)) {
        unset = true
        exact = arg.slice(NO.length) === name
        abbreviated = !exact && name.startsWith(arg.slice(NO.length))
      }
    }
    if (exact) return { spelling: gitSpelling(long, unset !== inverted) }
    if (abbreviated) {
      earlier = found
      found = [long, unset !== inverted]
    }
  }
  if (found === null) return null
  if (earlier !== null) return { ambiguous: [gitShown(...earlier), gitShown(...found)] }
  return { spelling: gitSpelling(...found) }
}

/** How git names a candidate in its ambiguity refusal. */
function gitShown(long: string, unset: boolean): string {
  return `--${unset ? NO : ''}${long}`
}

/** The long spelling one of git's options answers to, negated or not. */
function gitSpelling(long: string, unset: boolean): string {
  if (!unset) return `--${long}`
  return long.startsWith(NO) ? `--${long.slice(NO.length)}` : `--${NO}${long}`
}

/**
 * getopt_long prefix matching against a program's whole table.
 *
 * An entry spelled exactly names its option; otherwise every entry the typed
 * spelling prefixes is a candidate. glibc sets aside a later candidate that
 * names the same option as the first one, so one option's aliases resolve
 * where two options are ambiguous. The result length tells the caller
 * everything: 0 unknown, 1 the option's primary spelling, 2+ the
 * possibilities glibc lists (the first candidate and every later one naming
 * another option, in table order). `table` is each option's primary spelling
 * then its aliases, in the program's table order (LONG_OPTION_TABLES).
 * Mirrors Python's expand_table_long.
 */
export function expandTableLong(
  table: readonly (readonly string[])[],
  spelling: string,
): readonly string[] {
  const entries = table.flatMap((group) => group.map((name) => [name, group[0] ?? name] as const))
  for (const [name, primary] of entries) if (name === spelling) return [primary]
  if (spelling.length <= 2) return []
  const matches = entries.filter(([name]) => name.startsWith(spelling))
  const first = matches[0]
  if (first === undefined) return []
  const listed = [
    first[0],
    ...matches
      .slice(1)
      .filter(([, p]) => p !== first[1])
      .map(([n]) => n),
  ]
  return listed.length === 1 ? [first[1]] : listed
}

export function expandLong(
  cs: CompiledSpec,
  spelling: string,
  synonyms: ReadonlyMap<string, string> = new Map(),
): readonly string[] {
  if (cs.dest.has(spelling)) return [spelling]
  if (spelling.length <= 2) return []
  const matches = cs.longSpellings.filter((declared) => declared.startsWith(spelling))
  const first = matches[0]
  if (first === undefined) return []
  if (new Set(matches.map((declared) => synonyms.get(declared) ?? declared)).size === 1) {
    return [first]
  }
  return matches
}
