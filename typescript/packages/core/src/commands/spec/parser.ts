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
import {
  type CompiledSpec,
  argumentDest,
  compileSpec,
  expandGitLong,
  expandLong,
  expandTableLong,
  positionalName,
  positionalRequired,
} from './compile.ts'
import {
  ARG_PLACEHOLDER,
  ARGMATCH_CHOICE_OPTIONS,
  DASH_LETTER,
  DIGIT_OPTIONS,
  EQUALS_SHORT_VALUES,
  FLOAT_VALUE,
  flagKwargName,
  IN_ORDER_OPERANDS,
  INT_VALUE,
  LETTER_OPTIONS,
  LONG_OPTION_TABLES,
  LONG_SYNONYMS,
  NEGATIVE_NUMBER,
  NEGATIVE_NUMBER_OPERANDS,
  NO_LONG_OPTIONS,
  NUMERIC_SHORT,
  OPERAND,
  OWN_OPTION_LOOP,
  REFUSED,
  SPELLED,
  SPELLED_WORDS,
  SOLE_ARGUMENT_LONG_OPTIONS,
  STDIN_SCRIPT_COMMANDS,
  STDOUT_DASH_OPTIONS,
  WHOLE_WORD_LONG_OPTIONS,
} from './constants.ts'
import { flagOccurrences } from './flag_view.ts'
import { expandOldStyle } from './oldstyle.ts'
import type { CommandSpec, Argument, ValueType, ParsedFlagValue } from './types.ts'

/**
 * The builtin `Argument` objects whose choices are gnulib ARGMATCH tables.
 *
 * ARGMATCH_CHOICE_OPTIONS names them as "<command> <spelling>" because that
 * is how the measurement reads; this resolves each entry to the one object
 * the builtin spec declares, so `argmatchDests` can test `===` rather than
 * compare strings. An entry naming no option is a rotted table and throws
 * here, at module load. `_argmatch_options` in parser.py is the twin.
 */
function argmatchOptions(): readonly Argument[] {
  const found: Argument[] = []
  for (const key of [...ARGMATCH_CHOICE_OPTIONS].sort(compareCodePoints)) {
    const sep = key.indexOf(' ')
    const name = key.slice(0, sep)
    const spelling = key.slice(sep + 1)
    const options = (BUILTIN_SPECS[name]?.arguments ?? []).filter(
      (o) => (o.names.find((name) => name.startsWith('--')) ?? o.names[0]) === spelling,
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
 * Decided by `Argument` identity, not by the command's name: a mount may
 * register its own `tee` (commands/registry.ts), and a name is not an
 * identity. Identity is also the only signal that survives registration,
 * which parses an enriched COPY of the spec (config.ts appends
 * --help/--version, once per backend), while every declared Argument stays the
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
  for (const o of spec.arguments) {
    if (o.choices.length === 0) continue
    if (ARGMATCH_OPTIONS.some((table) => table === o)) dests.add(argumentDest(o))
  }
  return dests
}

export interface ParsedArgsInit {
  flags: Record<string, ParsedFlagValue>
  args: [string, ValueType][]
  rawPathFlags?: Record<string, ParsedFlagValue>
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
  readonly flags: Record<string, ParsedFlagValue>
  readonly args: [string, ValueType][]
  /** Selected PATH option values before cwd resolution, keyed like parseToKwargs. */
  readonly rawPathFlags: Record<string, ParsedFlagValue>
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
    this.rawPathFlags = init.rawPathFlags ?? {}
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
// sets those are was settled by `compileSpec`, by `Argument` identity rather
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
  flags: Record<string, ParsedFlagValue>,
  refusals: Refusals,
  cs: CompiledSpec,
  argmatchDestSet: ReadonlySet<string>,
  spelling: string,
  value: string | string[],
): void {
  const name = cs.destOf(spelling)
  const stored = (typeof value === 'string' ? [value] : value).map((part) =>
    checkValue(refusals, cs, argmatchDestSet, name, part),
  )
  flagOccurrences(flags).push(...stored.map((part): [string, ParsedFlagValue] => [name, part]))
  if (cs.multipleDests.has(name)) {
    const previous = flags[name]
    if (Array.isArray(previous)) previous.push(...stored)
    else flags[name] = stored
  } else if (Array.isArray(value)) {
    flags[name] = stored
  } else {
    Reflect.deleteProperty(flags, name)
    flags[name] = stored[0] ?? ''
  }
}

// The values the bag holds for one dest. The bare boolean form of an
// optional-value flag is exempt from the per-value checks, so it reads as
// no value at all.
function bagValues(flags: Record<string, ParsedFlagValue>, destName: string): string[] {
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

// The first operand a textWhen option turns textual, or null. Called after
// the scan, when the bag holds every option the line carried and its tape
// every option occurrence and operand in scan order. A program that reads its
// whole line first (tar's -x) turns every operand textual, wherever the option
// sits; one that files each operand as it reads it (IN_ORDER_OPERANDS) turns
// only the operands typed after the first such option. `_first_text_operand`
// in parser.py is the twin.
function firstTextOperand(
  flags: Record<string, ParsedFlagValue>,
  cs: CompiledSpec,
  textWhen: readonly string[],
  inOrder: boolean,
): number | null {
  const dests = new Set(textWhen.map((name) => cs.destOf(name)))
  if (!inOrder) return [...dests].some((dest) => dest in flags) ? 0 : null
  let operands = 0
  for (const [name] of flagOccurrences(flags)) {
    if (dests.has(name)) return operands
    if (name === OPERAND) operands += 1
  }
  return null
}

// Record a boolean flag occurrence under its canonical dest. A count flag
// accumulates occurrences into a number (`-vvv` and `-v -v -v` both land
// as 3); every other boolean flag is sticky true.
function setBoolFlag(
  flags: Record<string, ParsedFlagValue>,
  cs: CompiledSpec,
  spelling: string,
): void {
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
    if (cs.detachedOptionalSpellings.has(name)) {
      return { bools, valueFlag: name, attached: rest.length > 0 ? rest : null }
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

  const flags: Record<string, ParsedFlagValue> = {}
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
  let inOrderOperands: boolean
  let spelledWords: ReadonlySet<string>
  let letterOptions: boolean
  let negativeNumbers: boolean
  let wholeWords: boolean
  let ownLoop: boolean
  let longTable: readonly (readonly string[])[] | undefined
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
    inOrderOperands = false
    spelledWords = new Set()
    letterOptions = false
    negativeNumbers = false
    wholeWords = false
    ownLoop = false
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
    inOrderOperands = builtin && IN_ORDER_OPERANDS.has(cmdName)
    spelledWords = (builtin ? SPELLED_WORDS[cmdName] : undefined) ?? new Set()
    letterOptions = builtin && LETTER_OPTIONS.has(cmdName)
    negativeNumbers = builtin && NEGATIVE_NUMBER_OPERANDS.has(cmdName)
    wholeWords = builtin && WHOLE_WORD_LONG_OPTIONS.has(cmdName)
    ownLoop = builtin && OWN_OPTION_LOOP.has(cmdName)
    if (builtin) {
      for (const [key, same] of LONG_SYNONYMS) {
        const [name, spelling] = key.split(' ')
        if (name === cmdName && spelling !== undefined) synonyms.set(spelling, same)
      }
    }
    longTable = builtin ? LONG_OPTION_TABLES[cmdName] : undefined
  }

  // Leave a refusal on the tape, where a program that runs its own option
  // loop reports it, and say whether it went there. `refused_on_tape` in
  // parser.py is the twin.
  const refusedOnTape = (word: string): boolean => {
    if (ownLoop) flagOccurrences(flags).push([REFUSED, word])
    return ownLoop
  }

  let i = 0
  let endOfFlags = false
  const recordOperand = (word: string): void => {
    rawArgs.push(word)
    rawIndices.push(scanOrigins[i] ?? -1)
    rawBases.push(base)
    if (inOrderOperands || ownLoop) flagOccurrences(flags).push([OPERAND, word])
  }

  const recordValues = (
    spelling: string,
    arity: number,
    attachedValue: string | null = null,
  ): number => {
    const detached = arity - (attachedValue === null ? 0 : 1)
    const values = [
      ...(attachedValue === null ? [] : [attachedValue]),
      ...scanArgv.slice(i + 1, i + detached + 1),
    ]
    setValueFlag(flags, refusals, cs, argmatchDestSet, spelling, values)
    const kinds = cs.valueTypesByDest.get(cs.destOf(spelling)) ?? []
    for (let offset = 0; offset < detached; offset++) {
      wordKinds[scanOrigins[i + offset + 1] ?? -1] =
        kinds[offset + (attachedValue === null ? 0 : 1)] ?? cs.kindOf.get(spelling) ?? 'str'
    }
    return detached + 1
  }

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

    if (endOfFlags) {
      recordOperand(tok)
      i += 1
      continue
    }

    if (spelledWords.has(tok)) flagOccurrences(flags).push([SPELLED, tok])

    if (tok === '--') {
      endOfFlags = true
      i += 1
      continue
    }

    if (tok.startsWith('--')) {
      if (outsideSoleArgument) {
        // Outside gnulib's one-argument window the program has no long options
        // to recognize, so the word is an operand whether or not it is
        // declared: `expr --help x` is a syntax error on `x`, not a help
        // request.
        recordOperand(tok)
        i += 1
        continue
      }
      // getopt_long: an exact spelling always wins; otherwise an
      // unambiguous prefix expands to its declared spelling (grep --rec)
      // and an ambiguous one is refused with every possibility. A program
      // with no long-option parser keeps exact-only matching: its unknown
      // dash tokens are operands, not typos. expr inside its window is a
      // real getopt_long call, so `expr --h` does resolve to --help.
      const eqPos = wholeWords ? -1 : tok.indexOf('=')
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
      } else if (!cs.dest.has(typed) && longTable !== undefined) {
        // The program's own table decides, since a prefix of an option
        // mirage never declared is still ambiguous.
        const found = expandTableLong(longTable, typed)
        if (found.length > 1) {
          ambiguousOptions.push([tok, found])
          optionErrorKinds.push('ambiguous')
          i += 1
          continue
        }
        const only = found[0]
        if (only !== undefined) {
          const group = longTable.find((g) => g[0] === only)
          spelling = group?.find((name) => cs.dest.has(name)) ?? typed
        }
      } else if (!cs.dest.has(typed) && !noLongOptionParser && spec.allowAbbrev) {
        const candidates = expandLong(cs, typed, synonyms)
        if (candidates.length === 1) {
          spelling = candidates[0] ?? typed
        } else if (candidates.length > 1) {
          // glibc names the word as typed, `=value` and all (`ls: option
          // '--re=x' is ambiguous`).
          ambiguousOptions.push([tok, candidates])
          optionErrorKinds.push('ambiguous')
          i += 1
          continue
        }
      }
      const etok = eqPos === -1 ? spelling : spelling + tok.slice(eqPos)
      const dest = cs.destOf(spelling)
      const width = cs.nargsByDest.get(dest)
      if (cs.longBoolSpellings.has(etok)) {
        const next = scanArgv[i + 1]
        if (
          cs.detachedOptionalSpellings.has(etok) &&
          next !== undefined &&
          (!next.startsWith('-') || next === '-' || NEGATIVE_NUMBER.test(next))
        ) {
          setValueFlag(flags, refusals, cs, argmatchDestSet, etok, next)
          wordKinds[scanOrigins[i + 1] ?? -1] = cs.kindOf.get(etok) ?? null
          i += 2
        } else {
          setBoolFlag(flags, cs, etok)
          i += 1
        }
      } else if (width === 1 && eqPos !== -1) {
        i += recordValues(spelling, width, tok.slice(eqPos + 1))
      } else if (width !== undefined && eqPos === -1 && i + width < scanArgv.length) {
        i += recordValues(spelling, width)
      } else if (
        width === undefined &&
        cs.longValueSpellings.has(etok) &&
        i + 1 < scanArgv.length
      ) {
        setValueFlag(flags, refusals, cs, argmatchDestSet, etok, scanArgv[i + 1] ?? '')
        wordKinds[scanOrigins[i + 1] ?? -1] = cs.kindOf.get(etok) ?? null
        if (cs.destOf(etok) === cs.baseDest) wordBases[scanOrigins[i + 1] ?? -1] = base
        base = rebase(flags, cs, etok, scanArgv[i + 1] ?? '', base)
        i += 2
      } else if (width !== undefined) {
        if (eqPos === -1) {
          if (!refusedOnTape(spelling)) {
            needsValueOptions.push(spelling)
            optionErrorKinds.push('needs_value')
          }
        } else if (!refusedOnTape(tok)) {
          // Multi-value options have no `=` form (jq refuses `--arg=name`
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
          if (!refusedOnTape(etok)) {
            needsValueOptions.push(etok)
            optionErrorKinds.push('needs_value')
          }
        } else if (lenientDashOperands) {
          recordOperand(tok)
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
          if (!refusedOnTape(tok)) {
            invalidOptions.push(spelling + tok.slice(eqPos))
            optionErrorKinds.push('unexpected_value')
          }
        } else if (!refusedOnTape(tok)) {
          invalidOptions.push(tok)
          optionErrorKinds.push('invalid')
        }
        i += 1
      }
      continue
    }

    // A dash word with no letter after the dash is an operand to jq (`-1`,
    // `-.`, `- x`), so it falls through to the operands below.
    if (tok.startsWith('-') && tok.length > 1 && (!letterOptions || DASH_LETTER.test(tok))) {
      if (negativeNumbers && NEGATIVE_NUMBER.test(tok)) {
        recordOperand(tok)
        endOfFlags = true
        i += 1
        continue
      }
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
        const dest = cs.destOf(vf)
        const width = cs.nargsByDest.get(dest)
        if (width !== undefined && tok.startsWith(vf)) {
          const attachedValue =
            tok.length > vf.length ? attached(tok.slice(vf.length), equalsValues) : null
          const detached = width - (attachedValue === null ? 0 : 1)
          if (i + detached >= scanArgv.length) {
            needsValueOptions.push(vf.slice(1))
            optionErrorKinds.push('needs_value')
            i += 1
          } else {
            i += recordValues(vf, width, attachedValue)
          }
          matchedValue = true
          break
        }
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
        const next = scanArgv[i + 1]
        if (
          cs.detachedOptionalSpellings.has(tok) &&
          next !== undefined &&
          (!next.startsWith('-') || next === '-' || NEGATIVE_NUMBER.test(next))
        ) {
          setValueFlag(flags, refusals, cs, argmatchDestSet, tok, next)
          wordKinds[scanOrigins[i + 1] ?? -1] = cs.kindOf.get(tok) ?? null
          i += 2
        } else {
          setBoolFlag(flags, cs, tok)
          i += 1
        }
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
        if (!cs.boolSpellings.has(`-${ch}`) || cs.detachedOptionalSpellings.has(`-${ch}`)) {
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
        const dest = cs.destOf(mixed.valueFlag)
        const arity = cs.nargsByDest.get(dest)
        if (arity !== undefined) {
          const remaining = arity - (mixed.attached === null ? 0 : 1)
          if (i + remaining >= scanArgv.length) {
            needsValueOptions.push(mixed.valueFlag.slice(1))
            optionErrorKinds.push('needs_value')
            i += 1
          } else {
            for (const name of mixed.bools) setBoolFlag(flags, cs, name)
            i += recordValues(
              mixed.valueFlag,
              arity,
              mixed.attached === null ? null : attached(mixed.attached, equalsValues),
            )
          }
          continue
        }
        const next = scanArgv[i + 1]
        if (
          mixed.attached === null &&
          cs.detachedOptionalSpellings.has(mixed.valueFlag) &&
          (next === undefined ||
            (next.startsWith('-') && next !== '-' && !NEGATIVE_NUMBER.test(next)))
        ) {
          for (const name of [...mixed.bools, mixed.valueFlag]) setBoolFlag(flags, cs, name)
          i += 1
          continue
        }
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

      if (lenientDashOperands || (NUMERIC_SHORT.test(tok) && !isBuiltinGrammar(cmdName, spec))) {
        recordOperand(tok)
      } else if (cs.valueSpellings.includes(tok)) {
        // A declared value flag with no argument left on the line.
        if (!refusedOnTape(tok)) {
          needsValueOptions.push(tok.slice(1))
          optionErrorKinds.push('needs_value')
        }
      } else if (mixed !== null && mixed.attached === null) {
        // A cluster ending in a value flag that ran out of line.
        if (ownLoop) {
          // The loop reads the cluster's letters in turn.
          for (const name of mixed.bools) setBoolFlag(flags, cs, name)
        }
        if (!refusedOnTape(mixed.valueFlag)) {
          needsValueOptions.push(mixed.valueFlag.slice(1))
          optionErrorKinds.push('needs_value')
        }
      } else {
        // GNU reports the first offending character, not the token.
        let bad = tok.slice(1, 2)
        let before: string[] = []
        const read: string[] = []
        for (const ch of tok.slice(1)) {
          if (!cs.boolSpellings.has(`-${ch}`) && !cs.valueSpellings.includes(`-${ch}`)) {
            bad = ch
            before = read
            break
          }
          read.push(ch)
        }
        if (ownLoop) {
          // The letters before it are read first, so jq's `-hx` is help.
          for (const ch of before) {
            if (cs.boolSpellings.has(`-${ch}`)) setBoolFlag(flags, cs, `-${ch}`)
          }
        }
        if (!refusedOnTape(`-${bad}`)) {
          invalidOptions.push(bad)
          optionErrorKinds.push('invalid')
        }
      }
      i += 1
      continue
    }

    recordOperand(tok)
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

  const slots = cs.positional.filter(
    (op) => !op.providedBy.some((name) => cs.destOf(name) in flags),
  )
  let required =
    slots.filter(positionalRequired).length +
    Number(cs.rest !== null && positionalRequired(cs.rest))
  // An optional slot can consume only words not needed by required slots.
  const supplying: Argument[] = []
  for (const op of slots) {
    if (positionalRequired(op)) required -= 1
    else if (rawArgs.length - supplying.length <= required) continue
    supplying.push(op)
  }
  const positional: ValueType[] = supplying.map((op) => op.type)

  // A required slot the line left empty. Counted against the surviving slots
  // rather than the declared ones, so a flag standing in for a slot
  // (providedBy) satisfies it the same way a word would.
  const missingRequiredOperands = supplying
    .filter((op, index) => positionalRequired(op) && rawArgs.length <= index)
    .map((op) => (positionalName(op) === '' ? ARG_PLACEHOLDER : positionalName(op)))
  if (cs.rest !== null && positionalRequired(cs.rest) && rawArgs.length <= supplying.length) {
    missingRequiredOperands.push(
      positionalName(cs.rest) === '' ? ARG_PLACEHOLDER : positionalName(cs.rest),
    )
  }

  // A flag can turn the rest slot textual for this line only: tar's -x makes
  // every operand a member name rather than a file, and jq's --args makes the
  // operands typed after it positional strings rather than input files. Only
  // classification moves: unknown dash tokens stay as strict as the declared
  // kind makes them.
  const textFrom =
    cs.rest === null ? null : firstTextOperand(flags, cs, cs.rest.textWhen, inOrderOperands)

  // Overflow operands past the declared positional slots pass through
  // classified like the last slot (TEXT when there is none), so a
  // fixed-arity command receives them and raises its own extra-operand
  // UsageError (#452). The parser classifies, it never drops or raises.
  const overflowKind: ValueType = positional.at(-1) ?? 'str'

  const stdinScript = STDIN_SCRIPT_COMMANDS.has(cmdName) && isBuiltinGrammar(cmdName, spec)
  const classified: [string, ValueType][] = []
  const rawOperands: [string, ValueType][] = []
  for (let j = 0; j < rawArgs.length; j++) {
    const arg = rawArgs[j]
    if (arg === undefined) continue
    const operand = supplying[j] ?? cs.rest
    if (operand !== null && !spec.ignoreTokens.has(arg)) {
      checkValue(refusals, cs, new Set(), operand.names[0] ?? '', arg)
    }
    let kind: ValueType
    if (j < positional.length) {
      kind = positional[j] ?? 'str'
    } else if (textFrom !== null && j >= textFrom) {
      kind = 'str'
    } else if (cs.restKind !== null) {
      kind = cs.restKind
    } else {
      kind = overflowKind
    }
    if (stdinScript && kind === 'path' && arg === '-') kind = 'str'
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

  const rawPathFlags: Record<string, ParsedFlagValue> = {}
  const pathFlagValues: string[] = []
  for (const [flagName, kind] of cs.kindByDest) {
    if (kind !== 'path' || !(flagName in flags)) continue
    const val = flags[flagName]
    if (val !== undefined) rawPathFlags[flagKwargName(flagName)] = val
    if (Array.isArray(val) && cs.valueTypesByDest.has(flagName)) {
      // Only the odd slots are the paths: the even ones name them.
      const kinds = cs.valueTypesByDest.get(flagName) ?? []
      const paired = val.map((part, index) =>
        kinds[index % kinds.length] === 'path' ? resolvePath(part, cwd) : part,
      )
      flags[flagName] = paired
      pathFlagValues.push(...paired.filter((_, index) => kinds[index % kinds.length] === 'path'))
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
      if (val === '-' && STDOUT_DASH_OPTIONS.get(cmdName) === flagName) continue
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
    if (
      cs.kindByDest.get(name) === 'path' &&
      typeof value === 'string' &&
      !(value === '-' && STDOUT_DASH_OPTIONS.get(cmdName) === name)
    )
      occurrence[1] = resolvePath(value, cwd)
  }
  return new ParsedArgs({
    flags,
    args: classified,
    rawPathFlags,
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

export function parseToKwargs(parsed: ParsedArgs): Record<string, ParsedFlagValue> {
  const result: Record<string, ParsedFlagValue> = {}
  for (const [key, value] of Object.entries(parsed.flags)) {
    result[flagKwargName(key)] = value
  }
  flagOccurrences(result).push(
    ...flagOccurrences(parsed.flags).map(([name, value]): [string, ParsedFlagValue] => [
      flagKwargName(name),
      value,
    ]),
  )
  return result
}
