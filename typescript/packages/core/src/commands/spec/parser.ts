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

import { resolvePath } from '../../utils/path.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { type ArgmatchChoices, argmatch, valueClasses } from './argmatch.ts'
import { BUILTIN_SPECS, isBuiltinGrammar } from './builtins.ts'
import { type CompiledSpec, compileSpec, expandGitLong, expandLong } from './compile.ts'
import {
  ARG_PLACEHOLDER,
  ARGMATCH_CHOICE_OPTIONS,
  DIGIT_OPTIONS,
  EQUALS_SHORT_VALUES,
  FLOAT_VALUE,
  flagKwargName,
  INT_VALUE,
  LONG_SYNONYMS,
  NO_LONG_OPTIONS,
  NUMERIC_SHORT,
  SOLE_ARGUMENT_LONG_OPTIONS,
} from './constants.ts'
import { flagOccurrences } from './flag_view.ts'
import { expandOldStyle } from './oldstyle.ts'
import type { CommandSpec, Option, ValueType, FlagValue } from './types.ts'

/**
 * The builtin `Option` objects whose choices are gnulib ARGMATCH tables.
 *
 * ARGMATCH_CHOICE_OPTIONS names them as "<command> <spelling>" because that
 * is how the measurement reads; this resolves each entry to the one object
 * the builtin spec declares, so `argmatchDests` can test `===` rather than
 * compare strings. An entry naming no option is a rotted table and throws
 * here, at module load. `_argmatch_options` in parser.py is the twin.
 */
function argmatchOptions(): readonly Option[] {
  const found: Option[] = []
  for (const key of [...ARGMATCH_CHOICE_OPTIONS].sort(compareCodePoints)) {
    const sep = key.indexOf(' ')
    const name = key.slice(0, sep)
    const spelling = key.slice(sep + 1)
    const options = (BUILTIN_SPECS[name]?.options ?? []).filter(
      (o) => (o.long ?? o.short) === spelling,
    )
    if (options.length === 0) {
      throw new Error(
        `ARGMATCH_CHOICE_OPTIONS names ${name} ${spelling}, which that spec does not declare`,
      )
    }
    found.push(...options)
  }
  return found
}

const ARGMATCH_OPTIONS = argmatchOptions()

/**
 * Which of this spec's choice sets are gnulib ARGMATCH tables.
 *
 * Decided by `Option` identity, not by the command's name: a mount may
 * register its own `tee` (commands/registry.ts), and a name is not an
 * identity. Identity is also the only signal that survives registration,
 * which parses an enriched COPY of the spec (config.ts appends
 * --help/--version, once per backend), while every declared Option stays the
 * same object.
 *
 * Read off the spec rather than cached on its CompiledSpec so that the two
 * languages answer alike: python's `compile_spec` caches on a frozen
 * dataclass, so its key is structural and a spec that merely LOOKED like
 * tee's would share the builtin's compiled tables. This WeakMap is keyed by
 * reference and would not, and a fact that depended on which cache it sat in
 * is exactly the kind that drifts. `_argmatch_dests` in parser.py is the
 * twin.
 */
function argmatchDests(spec: CommandSpec): ReadonlySet<string> {
  const dests = new Set<string>()
  for (const o of spec.options) {
    if (o.choices.length === 0) continue
    if (ARGMATCH_OPTIONS.some((table) => table === o)) dests.add(o.long ?? o.short ?? '')
  }
  return dests
}

export interface ParsedArgsInit {
  flags: Record<string, FlagValue>
  args: [string, ValueType][]
  pathFlagValues?: string[]
  rawOperands?: [string, ValueType][]
  textFlagValues?: string[]
  warnings?: string[]
  wordKinds?: (ValueType | null)[]
  wordBases?: (string | null)[]
  invalidOptions?: string[]
  ambiguousOptions?: [string, readonly string[]][]
  optionErrorKinds?: string[]
  needsValueOptions?: string[]
  /**
   * Values ARGMATCH refused, in declaration order, each tagged with the
   * wording gnulib picks for it: `ls --color=a` is a prefix of `always` and
   * `auto`, two values, and reads `ambiguous argument 'a'`, while
   * `ls --color=zzz` matches nothing and reads `invalid argument 'zzz'`.
   * Both print the same candidate block; optionErrorKinds is what orders
   * them against each other and against every other refusal on the line.
   * Only the ARGMATCH_CHOICE_OPTIONS tables can fill the ambiguous
   * one, because only a prefix can be ambiguous.
   */
  invalidValueOptions?: [string, string, ArgmatchChoices][]
  ambiguousValueOptions?: [string, string, ArgmatchChoices][]
  invalidIntOptions?: [string, string][]
  invalidFloatOptions?: [string, string][]
  missingRequiredOptions?: string[]
  /**
   * Display names of required operand slots the line left empty, in
   * declaration order. Reported rather than thrown, like every other entry
   * here, so the dialect that words it is the caller's choice.
   */
  missingRequiredOperands?: string[]
  /**
   * Dests the line actually carried, in scan order, excluding the ones a
   * declared default filled in afterwards. A usage line that echoes what was
   * supplied (clap's) needs exactly this distinction: a defaulted option is
   * invisible there, a typed one is not.
   */
  typedDests?: string[]
  oldOptionNeedsValue?: string | null
}

export class ParsedArgs {
  readonly flags: Record<string, FlagValue>
  readonly args: [string, ValueType][]
  readonly pathFlagValues: string[]
  readonly rawOperands: [string, ValueType][]
  readonly textFlagValues: string[]
  readonly warnings: string[]
  readonly wordKinds: (ValueType | null)[]
  // Per-position base directory, aligned with wordKinds: the absolute
  // path a word resolves against when an operandBase option (tar's -C)
  // moved it, and null when the session cwd still applies. Only a spec
  // declaring operandBase ever fills this.
  readonly wordBases: (string | null)[]
  // GNU-shaped option errors, reported (never thrown) by the parser:
  // undeclared options ('--bogus' or the offending cluster char 'Y'),
  // abbreviated longs matching several options (typed prefix, matched
  // spellings in declaration order), declared value flags that ran out
  // of line ('--max-depth', 'm'), values outside a declared choices set
  // (canonical spelling, value, allowed values), non-integer values on
  // int-typed options (canonical spelling, value), and absent required
  // options (canonical spelling).
  readonly invalidOptions: string[]
  readonly ambiguousOptions: [string, readonly string[]][]
  // One tag per refusal in scan encounter order ("invalid",
  // "unexpected_value", "ambiguous", "needs_value", "int", "float",
  // "value"), so the refusal names the FIRST offending token like GNU (grep
  // --c --bogus reports --c; reversed reports --bogus; numfmt --from=bad
  // --bogus reports the value). Each tag's detail is the next entry of that
  // tag's own list. "unexpected_value" is a boolean
  // long handed a value, which getopt_long refuses in its own words rather
  // than as an unrecognized option; its entry in invalidOptions is the
  // option's canonical spelling with the typed value ("--byte-offset=2"),
  // so the two tags share one list and the renderer tells them apart by
  // the tag.
  readonly optionErrorKinds: string[]
  readonly needsValueOptions: string[]
  readonly invalidValueOptions: [string, string, ArgmatchChoices][]
  readonly ambiguousValueOptions: [string, string, ArgmatchChoices][]
  readonly invalidIntOptions: [string, string][]
  readonly invalidFloatOptions: [string, string][]
  readonly missingRequiredOptions: string[]
  readonly missingRequiredOperands: string[]
  readonly typedDests: string[]
  // The old-style cluster letter whose argument ran off the end of the
  // line (`tar xzf` with no archive). Its own report because GNU tar
  // words it differently and exits differently from every getopt refusal
  // above, and because it outranks all of them: tar counts the cluster's
  // argument needs before argp ever validates a letter, so `tar Qf` and
  // `tar fQ` both name f, not Q.
  readonly oldOptionNeedsValue: string | null

  constructor(init: ParsedArgsInit) {
    this.flags = init.flags
    this.args = init.args
    this.pathFlagValues = init.pathFlagValues ?? []
    this.rawOperands = init.rawOperands ?? []
    this.textFlagValues = init.textFlagValues ?? []
    this.warnings = init.warnings ?? []
    this.wordKinds = init.wordKinds ?? []
    this.wordBases = init.wordBases ?? []
    this.invalidOptions = init.invalidOptions ?? []
    this.ambiguousOptions = init.ambiguousOptions ?? []
    this.optionErrorKinds = init.optionErrorKinds ?? []
    this.needsValueOptions = init.needsValueOptions ?? []
    this.invalidValueOptions = init.invalidValueOptions ?? []
    this.ambiguousValueOptions = init.ambiguousValueOptions ?? []
    this.invalidIntOptions = init.invalidIntOptions ?? []
    this.invalidFloatOptions = init.invalidFloatOptions ?? []
    this.missingRequiredOptions = init.missingRequiredOptions ?? []
    this.missingRequiredOperands = init.missingRequiredOperands ?? []
    this.typedDests = init.typedDests ?? []
    this.oldOptionNeedsValue = init.oldOptionNeedsValue ?? null
  }

  paths(): string[] {
    return this.args.filter(([, k]) => k === 'path').map(([v]) => v)
  }

  routingPaths(): string[] {
    return [...this.paths(), ...this.pathFlagValues]
  }

  texts(): string[] {
    return this.args.filter(([, k]) => k !== 'path').map(([v]) => v)
  }

  flag(
    name: string,
    fallback: string | boolean | number | string[] | null = null,
  ): string | boolean | number | string[] | null {
    return this.flags[name] ?? fallback
  }
}

// The values the per-value checks refused, in the order read. `kinds` is
// the scan's shared `optionErrorKinds` tape: every refusal also drops its
// tag (`int`, `float`, `value`) there, beside the scan's own tags, so the
// reporter can tell which list holds the FIRST refusal on the line, the
// one GNU stops at.
interface Refusals {
  kinds: string[]
  ints: [string, string][]
  floats: [string, string][]
  values: [string, string, ArgmatchChoices][]
  ambiguousValues: [string, string, ArgmatchChoices][]
}

// Run one value through its dest's int, float and choices checks. Int-typed
// values are refused before choices, argparse's order (type conversion runs
// before the choices test), and one value is refused once: a non-numeric
// value on an int option that also declares choices reports the conversion
// failure, not the choice list.
//
// A declared `choices` set compares the WHOLE word, argparse's rule, unless
// the option declaring it is one of the gnulib ARGMATCH tables the
// parser owns, in which case an unambiguous prefix resolves to its
// candidate. The returned word is what the caller stores, so a command reads
// `none` where the line typed `non` and never learns the difference. Which
// sets those are was settled by `compileSpec`, by `Option` identity rather
// than by the command's name, so a registered command that borrows the name
// `tee` still compares the whole word. `_check_value` in parser.py is the
// twin.
function checkValue(
  refusals: Refusals,
  cs: CompiledSpec,
  argmatchDestSet: ReadonlySet<string>,
  dest: string,
  value: string,
): string {
  if (cs.intDests.has(dest) && !INT_VALUE.test(value)) {
    refusals.ints.push([dest, value])
    refusals.kinds.push('int')
    return value
  }
  if (cs.floatDests.has(dest) && !FLOAT_VALUE.test(value)) {
    refusals.floats.push([dest, value])
    refusals.kinds.push('float')
    return value
  }
  const allowed = cs.choicesByDest.get(dest)
  if (allowed === undefined) return value
  if (argmatchDestSet.has(dest)) {
    const match = argmatch(value, allowed)
    if (match.matched) return match.word
    if (match.kind === 'ambiguous') {
      refusals.ambiguousValues.push([dest, value, allowed])
      refusals.kinds.push('ambiguous_value')
      return value
    }
    refusals.values.push([dest, value, allowed])
    refusals.kinds.push('value')
    return value
  }
  for (const group of valueClasses(allowed)) {
    if (group.includes(value)) return group[0] ?? value
  }
  refusals.values.push([dest, value, allowed])
  refusals.kinds.push('value')
  return value
}

// Record a value flag occurrence under its canonical dest. Both spellings
// of one option land on the same key, so the last occurrence wins
// regardless of spelling (GNU: `cp --update=all -u` is `--update=older`)
// and `multiple` options accumulate in true command-line order
// (`sort -k1 --key=2` is `[1, 2]`).
//
// Every value is checked the moment it is read, as GNU's getopt loop and
// argparse's `type=` do, so `numfmt --to=bogus --to=si` is refused for
// `bogus` although the bag keeps only `si`, and `--from=bad1 --to=bad2`
// names `bad1`. Only what the environment or a default fills in afterwards
// is checked after the scan.
function setValueFlag(
  flags: Record<string, FlagValue>,
  refusals: Refusals,
  cs: CompiledSpec,
  argmatchDestSet: ReadonlySet<string>,
  spelling: string,
  value: string,
): void {
  const name = cs.destOf(spelling)
  const stored = checkValue(refusals, cs, argmatchDestSet, name, value)
  flagOccurrences(flags).push([name, stored])
  if (cs.multipleDests.has(name)) {
    const prev = flags[name]
    if (Array.isArray(prev)) {
      prev.push(stored)
    } else {
      flags[name] = [stored]
    }
  } else {
    Reflect.deleteProperty(flags, name)
    flags[name] = stored
  }
}

// The values the bag holds for one dest. The bare boolean form of an
// optional-value flag is exempt from the per-value checks, so it reads as
// no value at all.
function bagValues(flags: Record<string, FlagValue>, destName: string): string[] {
  const value = flags[destName]
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? [value] : []
}

// Fold one option occurrence into the operand base directory. Called
// after every value-flag record. Only the spec's declared operandBase
// option moves the base, and it moves it the way a chdir does: relative
// to wherever the previous occurrence left it, so `-C d1 ... -C ../d2`
// lands in d1/../d2. The resolved absolute path replaces the raw value
// in the flag bag, so the later path-flag pass has nothing left to do.
function rebase(
  flags: Record<string, string | boolean | number | string[]>,
  cs: CompiledSpec,
  spelling: string,
  value: string,
  base: string,
): string {
  if (cs.baseDest === null || cs.destOf(spelling) !== cs.baseDest) return base
  const moved = resolvePath(value, base)
  const bag = flags[cs.baseDest]
  if (Array.isArray(bag) && bag.length > 0) {
    // An accumulating option already appended the raw value; the
    // resolved one replaces it so nothing resolves it twice.
    bag[bag.length - 1] = moved
  } else {
    flags[cs.baseDest] = moved
  }
  return moved
}

// Record a boolean flag occurrence under its canonical dest. A count flag
// accumulates occurrences into a number (`-vvv` and `-v -v -v` both land
// as 3); every other boolean flag is sticky true.
function setBoolFlag(flags: Record<string, FlagValue>, cs: CompiledSpec, spelling: string): void {
  const name = cs.destOf(spelling)
  flagOccurrences(flags).push([name, true])
  if (cs.countDests.has(name)) {
    const prev = flags[name]
    flags[name] = typeof prev === 'number' ? prev + 1 : 1
  } else {
    Reflect.deleteProperty(flags, name)
    flags[name] = true
  }
}

interface MixedCluster {
  bools: string[]
  valueFlag: string
  attached: string | null
}

// getopt-style cluster of bool flags ending in a value flag, e.g. -ne / -nepat.
// An optional-value short (getopt's `x::`) takes whatever follows it in the
// cluster as its value, as getopt does, so `date -uIs` is `-u -Is`; with
// nothing after it, it is one more bool flag. Returns null when any character
// is unknown or no value flag terminates it.
// An attached short-option value, one leading `=` dropped for a program that
// reads `-x=VALUE` as `VALUE` (EQUALS_SHORT_VALUES).
function attached(value: string, equals: boolean): string {
  return equals && value.startsWith('=') ? value.slice(1) : value
}

function matchMixedCluster(tok: string, cs: CompiledSpec): MixedCluster | null {
  const bools: string[] = []
  const chars = tok.slice(1)
  for (let idx = 0; idx < chars.length; idx++) {
    const ch = chars[idx]
    if (ch === undefined) break
    const name = `-${ch}`
    const rest = chars.slice(idx + 1)
    if (rest.length > 0 && cs.attachSpellings.includes(name)) {
      return { bools, valueFlag: name, attached: rest }
    }
    if (cs.boolSpellings.has(name)) {
      bools.push(name)
      continue
    }
    if (cs.valueSpellings.includes(name)) {
      return { bools, valueFlag: name, attached: rest.length > 0 ? rest : null }
    }
    return null
  }
  return null
}

// A cluster of bool flags and digit options (`-d10`). For a DIGIT_OPTIONS
// program the digits are option letters too, and getopt hands them over one
// at a time into one number: every digit of the word joins it, wherever it
// sits (`-1d0` is ten). Null when a character is neither or no digit is
// present.
function matchDigitCluster(
  tok: string,
  cs: CompiledSpec,
): { bools: string[]; digits: string } | null {
  const bools: string[] = []
  let digits = ''
  for (const ch of tok.slice(1)) {
    if (ch >= '0' && ch <= '9') digits += ch
    else if (cs.boolSpellings.has(`-${ch}`)) bools.push(`-${ch}`)
    else return null
  }
  return digits === '' ? null : { bools, digits }
}

/**
 * Read one command line against a spec.
 *
 * `unknownIsOperand` says whether another parser reads this line after
 * mirage. False is a GNU command, where mirage is the only parser the line
 * will meet, so a dashed word the spec does not declare is `unrecognized
 * option`. True is an installed CLI's node, where the spec is deliberately
 * partial: mirage's `git log` declares the flags mirage enforces and git owns
 * the rest, so an undeclared dashed word is handed back as an operand for git
 * to refuse in git's own words and exit (`fatal: unrecognized argument: -p`).
 * It comes last and defaults to the GNU answer, because it is a fact about
 * the call rather than about the spec, and nothing on CommandSpec may say it:
 * the shared grammar stays what POSIX and argparse can both express. It says
 * nothing about `choices`, which compares the whole word for every spec
 * unless the option declaring the set is one of the builtin ARGMATCH
 * declarations -- an identity the spec itself settles, so it is not a fact
 * about the caller at all.
 *
 * `abbreviations` is the same kind of fact about the program reading the
 * line: its own full table of long options (git's `--[no-]` notation), when it
 * resolves an abbreviated long option against that table the way git's
 * parse-options does. A partial spec cannot answer whether `--no-m` is
 * ambiguous, since the option git would also match is one mirage never
 * declared, so the program's table is what is asked; an empty table is a
 * program that takes whole words only (git's revision walkers). Undefined
 * leaves the getopt_long reading against the spec.
 *
 * `parse_command` in parser.py is the twin.
 */
export function parseCommand(
  spec: CommandSpec,
  argv: string[],
  cwd: string,
  cmdName = '',
  env?: Readonly<Record<string, string>>,
  unknownIsOperand = false,
  abbreviations?: readonly string[],
): ParsedArgs {
  const cs = compileSpec(spec)
  const argmatchDestSet = argmatchDests(spec)

  // tar's old option style is expanded before anything else reads the
  // line, so classification, routing and dispatch all scan the same
  // dashed words; scanOrigins maps each of them back to the caller's
  // argv slot (every synthesized token to the cluster's own slot).
  const old = spec.oldOptionStyle ? expandOldStyle(cs, argv) : null
  const scanArgv = old !== null ? old.argv : argv
  const scanOrigins = old !== null ? old.origins : argv.map((_, idx) => idx)

  const flags: Record<string, FlagValue> = {}
  // Every scalar value-flag occurrence, in scan order, beside the bag that
  // keeps only the last of each. Appended to by setValueFlag and read by
  // nobody here: it leaves on the parse result.
  const rawArgs: string[] = []
  // rawIndices[k] = argv position of rawArgs[k]
  const rawIndices: number[] = []
  // Per-position operand kinds aligned with the caller's argv (null =
  // a word the scan never reads, such as tar's empty old-style cluster).
  // Positions, not value sets, so the same word can be TEXT in one slot
  // and PATH in another:
  //   grep  *.txt  *.txt                  -> [TEXT, PATH]
  //   find  /data  -name  *.txt           -> [PATH, TEXT, TEXT]
  //   tar   ""  f.txt                     -> [null, PATH]
  // scanOrigins/rawIndices map the parser's views back to argv slots
  // (scanArgv spells a tar cluster as one word per letter, rawArgs keeps
  // only operands); kinds must be written at the original positions or
  // one expanded cluster shifts every later kind onto the wrong word.
  const wordKinds: (ValueType | null)[] = new Array<ValueType | null>(argv.length).fill(null)
  // The directory the next path operand resolves against, and where it
  // was for each word already read. It only ever moves for a spec that
  // declares operandBase, so every other command records null throughout
  // and the classifier keeps using the session cwd.
  let base = cwd
  const wordBases: (string | null)[] = new Array<string | null>(argv.length).fill(null)
  const rawBases: string[] = []
  const warnings: string[] = []
  const invalidOptions: string[] = []
  const ambiguousOptions: [string, readonly string[]][] = []
  const optionErrorKinds: string[] = []
  const refusals: Refusals = {
    kinds: optionErrorKinds,
    ints: [],
    floats: [],
    values: [],
    ambiguousValues: [],
  }
  const needsValueOptions: string[] = []
  // Who owns a dashed word the spec does not declare. The caller already
  // answered that with unknownIsOperand.
  let noLongOptionParser: boolean
  let outsideSoleArgument: boolean
  let lenientDashOperands: boolean
  let digitOptions: boolean
  let equalsValues: boolean
  const synonyms = new Map<string, string>()
  if (unknownIsOperand) {
    // Where the word goes is still the grammar's to say: it lands in a textual
    // rest slot when the node has one (git's `log -p`, and a script root whose
    // whole line is forwarded) and is refused here when the node declares no
    // slot for it (`pager --frobnicate`). The rest kind can answer that here
    // and could not answer it for a GNU command: a CLI node's textual rest IS
    // the pass-through slot, while basename's is a list of names, and eleven
    // GNU specs share basename's shape.
    lenientDashOperands = cs.restKind !== null && cs.restKind !== 'path' && !cs.remainder
    noLongOptionParser = lenientDashOperands
    outsideSoleArgument = false
    digitOptions = false
    equalsValues = false
  } else {
    // getopt_long, with exactly two exceptions, both named rather than derived
    // from the spec because nothing in a declaration tells them apart: see
    // NO_LONG_OPTIONS and SOLE_ARGUMENT_LONG_OPTIONS for the measurements and
    // for why #1107's "declares no long options" predicate cannot work. A
    // program with no long-option parser prints a dash word it does not know
    // instead of refusing it, and never expands an abbreviation.
    // Both tables name one real program, so both are gated on this spec
    // being that program's own grammar: a mount may register a command under
    // a builtin's name (nothing refuses it), and the sole-argument rule turns
    // such a spec's declared `--mode=x` into an operand its handler then
    // never sees.
    const builtin = isBuiltinGrammar(cmdName, spec)
    noLongOptionParser = builtin && NO_LONG_OPTIONS.has(cmdName)
    // gnulib's parse_long_options reads argv[1] only when it is the whole
    // line, so outside that one-argument window the program has no long
    // options AT ALL and even an exact `--help` is an operand.
    const soleArgument = builtin && SOLE_ARGUMENT_LONG_OPTIONS.has(cmdName)
    outsideSoleArgument = soleArgument && argv.length !== 1
    // A dash-leading word this program answers by printing it as an operand
    // rather than by refusing it.
    lenientDashOperands = noLongOptionParser || soleArgument
    // Gated the same way: the digit letters and the synonym pairs are the real
    // program's own tables, not facts any declaration states.
    digitOptions = builtin && DIGIT_OPTIONS.has(cmdName)
    equalsValues = builtin && EQUALS_SHORT_VALUES.has(cmdName)
    if (builtin) {
      for (const [key, same] of LONG_SYNONYMS) {
        const [name, spelling] = key.split(' ')
        if (name === cmdName && spelling !== undefined) synonyms.set(spelling, same)
      }
    }
  }
  let i = 0
  let endOfFlags = false

  while (i < scanArgv.length) {
    const tok = scanArgv[i]
    if (tok === undefined) break
    // Keep option words literal: the shape heuristic would treat
    // `-o/data/out` as a relative path. Synthesized tar flags mark the
    // original cluster here; values and operands receive their own kinds.
    wordKinds[scanOrigins[i] ?? -1] = 'str'

    if (!endOfFlags && spec.ignoreTokens.has(tok)) {
      // Expression syntax, never an operand of the declared kind: `find
      // /d \( -name x \) ! -empty` would otherwise classify "(", ")" and
      // "!" as PATH operands, giving find three phantom start points on
      // top of the real one.
      i += 1
      continue
    }

    if (tok === '--' && !endOfFlags) {
      endOfFlags = true
      i += 1
      continue
    }

    if (endOfFlags) {
      rawArgs.push(tok)
      rawIndices.push(scanOrigins[i] ?? -1)
      rawBases.push(base)
      i += 1
      continue
    }

    if (tok.startsWith('--')) {
      if (outsideSoleArgument) {
        // Outside gnulib's one-argument window the program has no long options
        // to recognize, so the word is an operand whether or not it is
        // declared: `expr --help x` is a syntax error on `x`, not a help
        // request.
        rawArgs.push(tok)
        rawIndices.push(scanOrigins[i] ?? -1)
        rawBases.push(base)
        i += 1
        continue
      }
      // getopt_long: an exact spelling always wins; otherwise an
      // unambiguous prefix expands to its declared spelling (grep --rec)
      // and an ambiguous one is refused with every possibility. A program
      // with no long-option parser keeps exact-only matching: its unknown
      // dash tokens are operands, not typos. expr inside its window is a
      // real getopt_long call, so `expr --h` does resolve to --help.
      const eqPos = tok.indexOf('=')
      const typed = eqPos === -1 ? tok : tok.slice(0, eqPos)
      let spelling = typed
      if (!cs.dest.has(typed) && abbreviations !== undefined) {
        const resolved = expandGitLong(abbreviations, typed)
        if (resolved !== null && 'ambiguous' in resolved) {
          ambiguousOptions.push([tok, resolved.ambiguous])
          optionErrorKinds.push('ambiguous')
          i += 1
          continue
        }
        if (resolved !== null && cs.dest.has(resolved.spelling)) spelling = resolved.spelling
      } else if (!cs.dest.has(typed) && !noLongOptionParser) {
        const candidates = expandLong(cs, typed, synonyms)
        if (candidates.length === 1) {
          spelling = candidates[0] ?? typed
        } else if (candidates.length > 1) {
          ambiguousOptions.push([typed, candidates])
          optionErrorKinds.push('ambiguous')
          i += 1
          continue
        }
      }
      const etok = eqPos === -1 ? spelling : spelling + tok.slice(eqPos)
      const isPair = cs.pairDests.has(cs.destOf(spelling))
      if (cs.longBoolSpellings.has(etok)) {
        setBoolFlag(flags, cs, etok)
        i += 1
      } else if (isPair && eqPos === -1 && i + 2 < scanArgv.length) {
        // Two tokens, both recorded under the one dest, so the command
        // reads the accumulated list in twos.
        setValueFlag(flags, refusals, cs, argmatchDestSet, spelling, scanArgv[i + 1] ?? '')
        setValueFlag(flags, refusals, cs, argmatchDestSet, spelling, scanArgv[i + 2] ?? '')
        // The first token names the value and is always textual; the
        // option's own kind describes the second.
        wordKinds[scanOrigins[i + 1] ?? -1] = 'str'
        wordKinds[scanOrigins[i + 2] ?? -1] = cs.kindOf.get(spelling) ?? null
        i += 3
      } else if (!isPair && cs.longValueSpellings.has(etok) && i + 1 < scanArgv.length) {
        setValueFlag(flags, refusals, cs, argmatchDestSet, etok, scanArgv[i + 1] ?? '')
        wordKinds[scanOrigins[i + 1] ?? -1] = cs.kindOf.get(etok) ?? null
        if (cs.destOf(etok) === cs.baseDest) wordBases[scanOrigins[i + 1] ?? -1] = base
        base = rebase(flags, cs, etok, scanArgv[i + 1] ?? '', base)
        i += 2
      } else if (isPair) {
        if (eqPos === -1) {
          needsValueOptions.push(spelling)
          optionErrorKinds.push('needs_value')
        } else {
          // A two-token option has no `=` form (jq refuses `--arg=name`
          // as an unknown option).
          invalidOptions.push(tok)
          optionErrorKinds.push('invalid')
        }
        i += 1
      } else {
        if (
          eqPos !== -1 &&
          (cs.longValueSpellings.has(spelling) || cs.longOptionalSpellings.has(spelling))
        ) {
          setValueFlag(flags, refusals, cs, argmatchDestSet, spelling, tok.slice(eqPos + 1))
          base = rebase(flags, cs, spelling, tok.slice(eqPos + 1), base)
        } else if (cs.longValueSpellings.has(etok)) {
          // Declared value flag at end of line with no argument.
          needsValueOptions.push(etok)
          optionErrorKinds.push('needs_value')
        } else if (lenientDashOperands) {
          rawArgs.push(tok)
          rawIndices.push(scanOrigins[i] ?? -1)
          rawBases.push(base)
        } else if (eqPos !== -1 && cs.longBoolSpellings.has(spelling)) {
          // A boolean long handed a value. getopt_long knows the option, so
          // it refuses the VALUE and names the option without it, which is a
          // different message from the unrecognized one below (`grep
          // --byte-offset=2` is "option '--byte-offset' doesn't allow an
          // argument", not "unrecognized option '--byte-offset=2'"). Reported
          // as the CANONICAL spelling plus the typed value, because GNU names
          // the canonical one even for an abbreviation -- `grep --byte=2`
          // answers for --byte-offset -- and because the programs that word
          // this as an unknown option quote the value along with it.
          invalidOptions.push(spelling + tok.slice(eqPos))
          optionErrorKinds.push('unexpected_value')
        } else {
          invalidOptions.push(tok)
          optionErrorKinds.push('invalid')
        }
        i += 1
      }
      continue
    }

    if (tok.startsWith('-') && tok.length > 1) {
      if (cs.numericDest !== null && NUMERIC_SHORT.test(tok)) {
        flags[cs.numericDest] = tok.slice(1)
        i += 1
        continue
      }
      let matchedOptional = false
      for (const vf of cs.attachSpellings) {
        if (tok.startsWith(vf) && tok.length > vf.length) {
          setValueFlag(flags, refusals, cs, argmatchDestSet, vf, tok.slice(vf.length))
          base = rebase(flags, cs, vf, tok.slice(vf.length), base)
          i += 1
          matchedOptional = true
          break
        }
      }
      if (matchedOptional) continue
      let matchedValue = false
      for (const vf of cs.valueSpellings) {
        if (tok === vf && i + 1 < scanArgv.length) {
          setValueFlag(flags, refusals, cs, argmatchDestSet, vf, scanArgv[i + 1] ?? '')
          wordKinds[scanOrigins[i + 1] ?? -1] = cs.kindOf.get(vf) ?? null
          if (cs.destOf(vf) === cs.baseDest) wordBases[scanOrigins[i + 1] ?? -1] = base
          base = rebase(flags, cs, vf, scanArgv[i + 1] ?? '', base)
          i += 2
          matchedValue = true
          break
        }
        if (tok.startsWith(vf) && tok.length > vf.length) {
          const attachedValue = attached(tok.slice(vf.length), equalsValues)
          setValueFlag(flags, refusals, cs, argmatchDestSet, vf, attachedValue)
          base = rebase(flags, cs, vf, attachedValue, base)
          i += 1
          matchedValue = true
          break
        }
      }
      if (matchedValue) {
        continue
      }

      if (cs.boolSpellings.has(tok)) {
        setBoolFlag(flags, cs, tok)
        i += 1
        continue
      }

      const digitCluster =
        digitOptions && cs.numericDest !== null ? matchDigitCluster(tok, cs) : null
      if (digitCluster !== null && cs.numericDest !== null) {
        for (const name of digitCluster.bools) setBoolFlag(flags, cs, name)
        Reflect.deleteProperty(flags, cs.numericDest)
        flags[cs.numericDest] = digitCluster.digits
        i += 1
        continue
      }

      let allBool = true
      for (const ch of tok.slice(1)) {
        if (!cs.boolSpellings.has(`-${ch}`)) {
          allBool = false
          break
        }
      }
      if (allBool && tok.length > 1) {
        for (const ch of tok.slice(1)) setBoolFlag(flags, cs, `-${ch}`)
        i += 1
        continue
      }

      const mixed = matchMixedCluster(tok, cs)
      if (mixed !== null) {
        if (mixed.attached !== null) {
          const attachedValue = attached(mixed.attached, equalsValues)
          for (const name of mixed.bools) setBoolFlag(flags, cs, name)
          setValueFlag(flags, refusals, cs, argmatchDestSet, mixed.valueFlag, attachedValue)
          base = rebase(flags, cs, mixed.valueFlag, attachedValue, base)
          i += 1
          continue
        }
        if (i + 1 < scanArgv.length) {
          for (const name of mixed.bools) setBoolFlag(flags, cs, name)
          setValueFlag(flags, refusals, cs, argmatchDestSet, mixed.valueFlag, scanArgv[i + 1] ?? '')
          wordKinds[scanOrigins[i + 1] ?? -1] = cs.kindOf.get(mixed.valueFlag) ?? null
          if (cs.destOf(mixed.valueFlag) === cs.baseDest) {
            wordBases[scanOrigins[i + 1] ?? -1] = base
          }
          base = rebase(flags, cs, mixed.valueFlag, scanArgv[i + 1] ?? '', base)
          i += 2
          continue
        }
      }

      if (lenientDashOperands || NUMERIC_SHORT.test(tok)) {
        rawArgs.push(tok)
        rawIndices.push(scanOrigins[i] ?? -1)
        rawBases.push(base)
      } else if (cs.valueSpellings.includes(tok)) {
        // A declared value flag with no argument left on the line.
        needsValueOptions.push(tok.slice(1))
        optionErrorKinds.push('needs_value')
      } else if (mixed !== null && mixed.attached === null) {
        // A cluster ending in a value flag that ran out of line.
        needsValueOptions.push(mixed.valueFlag.slice(1))
        optionErrorKinds.push('needs_value')
      } else {
        // GNU reports the first offending character, not the token.
        let bad = tok.slice(1, 2)
        for (const ch of tok.slice(1)) {
          if (!cs.boolSpellings.has(`-${ch}`) && !cs.valueSpellings.includes(`-${ch}`)) {
            bad = ch
            break
          }
        }
        invalidOptions.push(bad)
        optionErrorKinds.push('invalid')
      }
      i += 1
      continue
    }

    rawArgs.push(tok)
    rawIndices.push(scanOrigins[i] ?? -1)
    rawBases.push(base)
    // The first operand ends option parsing outright under
    // argparse's REMAINDER, so a script's own flags reach the script
    // of being read as the interpreter's.
    if (cs.remainder) endOfFlags = true
    i += 1
  }

  // Snapshot before defaults land, because "typed" and "present" stop being
  // the same set one line below. A dialect that echoes the options a line
  // carried (clap's missing-argument usage) needs the former, and key order is
  // the order they were scanned in.
  const typedDests = Object.keys(flags)

  // An option's declared variable lands exactly where a default does, so it
  // gets the same coercion, the same choices test, the same PATH resolution
  // and the same required credit. Filling it after the parse instead would
  // leave an int unchecked and a path a bare string. It goes in ahead of the
  // defaults because it outranks one, it yields to anything the line typed,
  // and it lands below the snapshot because clap's usage line distinguishes
  // an option the line carried from one the environment supplied.
  for (const [destName, variable] of cs.envByDest) {
    if (destName in flags) continue
    const supplied = env?.[variable]
    if (supplied === undefined || supplied === '') continue
    flags[destName] = cs.multipleDests.has(destName) ? [supplied] : supplied
  }

  // Declared defaults land as if typed, before choices/required checks
  // and before PATH/TEXT flag-value collection, so a PATH default
  // resolves and routes and a default always satisfies required. A
  // multiple dest holds lists, so its default is a one-element list.
  for (const [destName, defaultValue] of cs.defaults) {
    if (!(destName in flags)) {
      flags[destName] = cs.multipleDests.has(destName) ? [defaultValue] : defaultValue
    }
  }

  // Every typed value was checked as it was read; what a default or the
  // environment filled in afterwards is checked here. An ARGMATCH dest
  // canonicalizes here too, so a default spelled as a prefix reaches the
  // command as the candidate it names.
  const checked = new Set([...cs.intDests, ...cs.floatDests, ...cs.choicesByDest.keys()])
  for (const destName of checked) {
    if (typedDests.includes(destName)) continue
    const values = bagValues(flags, destName)
    const stored = values.map((part) => checkValue(refusals, cs, argmatchDestSet, destName, part))
    if (stored.length > 0 && stored.some((word, at) => word !== values[at])) {
      flags[destName] = Array.isArray(flags[destName]) ? stored : (stored[0] ?? '')
    }
  }

  const missingRequiredOptions = cs.requiredDests.filter((destName) => !(destName in flags))

  const supplying = spec.positional.filter(
    (op) => !op.providedBy.some((name) => cs.destOf(name) in flags),
  )
  const positional: ValueType[] = supplying.map((op) => op.type)

  // A required slot the line left empty. Counted against the surviving slots
  // rather than the declared ones, so a flag standing in for a slot
  // (providedBy) satisfies it the same way a word would.
  const missingRequiredOperands = supplying
    .filter((op, index) => op.required && rawArgs.length <= index)
    .map((op) => (op.name === '' ? ARG_PLACEHOLDER : op.name))
  if (spec.rest !== null && spec.rest.required && rawArgs.length <= supplying.length) {
    missingRequiredOperands.push(spec.rest.name === '' ? ARG_PLACEHOLDER : spec.rest.name)
  }

  // A flag can turn the rest slot textual for this line only (jq's
  // --args makes every later operand a positional string rather than an
  // input file). Only classification moves: unknown dash tokens stay as
  // strict as the declared kind makes them.
  const restKind: ValueType | null = spec.rest?.textWhen.some((name) => cs.destOf(name) in flags)
    ? 'str'
    : cs.restKind

  // Overflow operands past the declared positional slots pass through
  // classified like the last slot (TEXT when there is none), so a
  // fixed-arity command receives them and raises its own extra-operand
  // UsageError (#452). The parser classifies, it never drops or raises.
  const overflowKind: ValueType = positional.at(-1) ?? 'str'

  const classified: [string, ValueType][] = []
  const rawOperands: [string, ValueType][] = []
  for (let j = 0; j < rawArgs.length; j++) {
    const arg = rawArgs[j]
    if (arg === undefined) continue
    let kind: ValueType
    if (j < positional.length) {
      kind = positional[j] ?? 'str'
    } else if (restKind !== null) {
      kind = restKind
    } else {
      kind = overflowKind
    }
    if (kind === 'path') {
      // Against the base an operandBase option left in effect at this
      // position, which is the session cwd for every command that
      // declares none.
      const here = rawBases[j] ?? cwd
      classified.push([resolvePath(arg, here), 'path'])
      rawOperands.push([arg, 'path'])
      const baseIdx = rawIndices[j]
      if (here !== cwd && baseIdx !== undefined && baseIdx >= 0) wordBases[baseIdx] = here
    } else {
      classified.push([arg, kind])
      rawOperands.push([arg, kind])
    }
    const origIdx = rawIndices[j]
    if (origIdx !== undefined && origIdx >= 0) wordKinds[origIdx] = kind
  }

  const pathFlagValues: string[] = []
  for (const [flagName, kind] of cs.kindByDest) {
    if (kind !== 'path' || !(flagName in flags)) continue
    const val = flags[flagName]
    if (Array.isArray(val) && cs.pairDests.has(flagName)) {
      // Only the odd slots are the paths: the even ones name them.
      const paired = val.map((part, index) => (index % 2 ? resolvePath(part, cwd) : part))
      flags[flagName] = paired
      pathFlagValues.push(...paired.filter((_, index) => index % 2 === 1))
    } else if (Array.isArray(val)) {
      const resolvedList = val.map((part) =>
        part === '-' &&
        ['grep', 'rg', 'sed', 'awk'].includes(cmdName) &&
        ['-f', '--file'].includes(flagName)
          ? '-'
          : resolvePath(part, cwd),
      )
      flags[flagName] = resolvedList
      pathFlagValues.push(...resolvedList)
    } else if (typeof val === 'string') {
      const resolved = resolvePath(val, cwd)
      flags[flagName] = resolved
      pathFlagValues.push(resolved)
    }
  }

  const textFlagValues: string[] = []
  for (const [flagName, kind] of cs.kindByDest) {
    if (kind === 'path' || !(flagName in flags)) continue
    const val = flags[flagName]
    if (Array.isArray(val)) {
      textFlagValues.push(...val)
    } else if (typeof val === 'string') {
      textFlagValues.push(val)
    }
  }

  for (const occurrence of flagOccurrences(flags)) {
    const [name, value] = occurrence
    if (cs.kindByDest.get(name) === 'path' && typeof value === 'string')
      occurrence[1] = resolvePath(value, cwd)
  }
  return new ParsedArgs({
    flags,
    args: classified,
    pathFlagValues,
    rawOperands,
    textFlagValues,
    warnings,
    invalidOptions,
    ambiguousOptions,
    optionErrorKinds,
    needsValueOptions,
    invalidValueOptions: refusals.values,
    ambiguousValueOptions: refusals.ambiguousValues,
    invalidIntOptions: refusals.ints,
    invalidFloatOptions: refusals.floats,
    missingRequiredOptions,
    missingRequiredOperands,
    typedDests,
    oldOptionNeedsValue: old !== null ? old.needsValue : null,
    wordKinds,
    wordBases,
  })
}

export function parseToKwargs(parsed: ParsedArgs): Record<string, FlagValue> {
  const result: Record<string, FlagValue> = {}
  for (const [key, value] of Object.entries(parsed.flags)) {
    result[flagKwargName(key)] = value
  }
  flagOccurrences(result).push(
    ...flagOccurrences(parsed.flags).map(([name, value]): [string, FlagValue] => [
      flagKwargName(name),
      value,
    ]),
  )
  return result
}
