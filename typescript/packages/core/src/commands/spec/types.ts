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

import type { PathSpec } from '../../types.ts'
import { ImmutableSet } from '../../utils/immutable_set.ts'

// Command names the spec layer references by value. Not a registry of
// every command: only names that appear away from their own module
// (usage message shapes, arity guards). Members are their plain string
// values, so the raw string the executor passes still matches. Mirrors
// the Python CommandName StrEnum and the crossmount Cmd pattern.
export enum CommandName {
  BASE64 = 'base64',
  CMP = 'cmp',
  COMM = 'comm',
  CSPLIT = 'csplit',
  DATE = 'date',
  DIFF = 'diff',
  FIND = 'find',
  JOIN = 'join',
  LOOK = 'look',
  MKTEMP = 'mktemp',
  PATCH = 'patch',
  SEQ = 'seq',
  SPLIT = 'split',
  TR = 'tr',
  TSORT = 'tsort',
  UNAME = 'uname',
  UNIQ = 'uniq',
  XXD = 'xxd',
}

// The one type axis for option and operand values (argparse type= as
// data, extended with the two members mirage's own parsing needs: 'bool'
// consumes no token, 'path' enters the resolve/route/PathSpec pipeline).
// 'str' is inert; 'int'/'float' are validated post-scan. Rule for every
// consumer: never enumerate the textual family; test === 'path' or
// === 'bool' (or their negations) only, so new validator types never
// touch classification sites.
export type ValueType = 'bool' | 'str' | 'int' | 'float' | 'path'

/**
 * Which program's voice a CLI answers usage questions in.
 *
 * An installed CLI is not a GNU tool, so a leaf that refuses an option it does
 * not declare answers in argparse's shape and exit code by default. A CLI that
 * mimics an existing program has to answer in that program's shape instead:
 * mirage implements a subset of git, so most of git's real options arrive
 * undeclared, and an agent that reads the refusal should see what git would
 * have said rather than learn that it is talking to a reimplementation.
 *
 * GIT covers the unknown-option refusal and the exit code, which is what an
 * undeclared flag produces; every other usage error (a missing value, an
 * unparseable int) stays in argparse's shape, because those only happen for
 * options a CLI does declare.
 *
 * CLAP additionally governs how help is laid out and how a missing operand is
 * refused, because a clap program prints a bare description line, spells the
 * option placeholder `[OPTIONS]`, heads the option list `Options:`, lists
 * subcommands in declaration order, and names the empty slots rather than
 * leaving each leaf to word its own complaint. Those are one decision (whose
 * voice this is), so they read off this knob rather than a second one.
 *
 * It lives in the spec layer, not beside the CLI tree, because the help
 * renderer is the spec's and cannot import upward to reach it.
 */
export enum UsageStyle {
  ARGPARSE = 'argparse',
  GIT = 'git',
  CLAP = 'clap',
}

export interface OptionInit {
  /** Short form, e.g. "-e". */
  short?: string | null
  /** Long form, e.g. "--max-depth". */
  long?: string | null
  /**
   * The flag's one type axis. 'bool' (the default) consumes no token and
   * clusters; 'path' values are cwd-resolved and routed for mount
   * dispatch, and reach the command as PathSpec; 'str' values pass
   * through untouched; 'int'/'float' values are refused at parse time
   * when they are not numbers (the portable numeric core shared by both
   * languages). The bag holds the string either way: commands read it
   * through FlagView.asInt / asFloat.
   */
  type?: ValueType
  /** Treat "-<digits>" as this flag's value (e.g. head -5). */
  numericShorthand?: boolean
  /**
   * Boolean flag whose occurrences accumulate into a number (click count
   * semantics): `-vvv` and `-v -v -v` both parse as 3. Only meaningful
   * with valueKind NONE.
   */
  count?: boolean
  /**
   * Repeated occurrences accumulate into a list instead of last-wins
   * (argparse append / click multiple, e.g. grep -e). Multiple PATH
   * flags resolve and route each path.
   */
  multiple?: boolean
  /**
   * The option consumes two tokens, not one (jq's `--arg name value`;
   * click's nargs=2). Occurrences always accumulate, flattened, so
   * `--arg a 1 --arg b 2` arrives as `['a', '1', 'b', '2']` and the
   * command reads it in twos. The first token of each pair names the
   * value and is always textual; `type` describes the second, so a
   * 'path' pair (`--rawfile name file`) resolves and routes only the
   * file. An `=` form is not accepted (neither does jq), and a trailing
   * occurrence missing either token is the usual "requires an argument"
   * refusal.
   */
  pair?: boolean
  /**
   * GNU optional-argument long option (e.g. `--color[=WHEN]`): bare
   * `--color` parses as true, `--color=auto` parses as the string, and a
   * detached next token is never consumed. Requires a long form.
   */
  valueOptional?: boolean
  /**
   * Whether the short spelling of a value flag may carry an attached value
   * (`split -d10`). False for GNU pairs whose short is a plain boolean
   * while only the long accepts a value (`cp -b` vs `--backup[=CONTROL]`),
   * so the short clusters (`-bv`) instead of eating the rest as a value.
   */
  shortValue?: boolean
  /**
   * Allowed values for a value flag. Any other value is reported (never
   * thrown) by the parser and surfaces as GNU's ARGMATCH refusal
   * (`tee: invalid argument 'x' for '--output-error'` plus the valid
   * list). The bare boolean form of an optional-value flag is exempt.
   */
  choices?: readonly string[]
  /**
   * The option must appear on the line; a line without it (and without a
   * default) is a usage error. Click spelling; GNU tools express this
   * per-command by hand.
   */
  required?: boolean
  /**
   * Value recorded when the flag is absent, as if it had been typed (a
   * PATH default resolves and routes, a defaulted value must satisfy
   * choices). Presence of a default always satisfies `required`.
   */
  default?: string | null
  /**
   * The value's name in a usage line, bare (`VERSION`, rendered
   * `--notion-version <VERSION>`); the brackets belong to the renderer, which
   * is the only thing that knows the dialect. Only a program whose usage lines
   * are rendered in someone else's needs one, since otherwise the name is
   * derived from the long spelling.
   */
  metavar?: string
  /**
   * Environment variable that supplies this option when the line omits it.
   * Distinct from `default`, and not a synonym for it: an env-sourced value
   * counts as *supplied* (clap echoes it in a usage line, where a defaulted one
   * is invisible), and it is read from the session rather than frozen into the
   * spec. Declaring it here is what keeps one fact in one place, since both the
   * leaf that sends the value and the renderer that reports the line need it.
   */
  env?: string
  description?: string
}

export class Option {
  readonly short: string | null
  readonly long: string | null
  readonly type: ValueType
  readonly numericShorthand: boolean
  readonly count: boolean
  readonly multiple: boolean
  readonly pair: boolean
  readonly valueOptional: boolean
  readonly shortValue: boolean
  readonly choices: readonly string[]
  readonly required: boolean
  readonly default: string | null
  readonly metavar: string | null
  readonly env: string | null
  readonly description: string | null

  constructor(init: OptionInit = {}) {
    this.short = init.short ?? null
    this.long = init.long ?? null
    this.type = init.type ?? 'bool'
    this.numericShorthand = init.numericShorthand ?? false
    this.count = init.count ?? false
    this.multiple = init.multiple ?? false
    this.pair = init.pair ?? false
    this.valueOptional = init.valueOptional ?? false
    this.shortValue = init.shortValue ?? true
    this.choices = Object.freeze([...(init.choices ?? [])])
    this.required = init.required ?? false
    this.default = init.default ?? null
    this.metavar = init.metavar ?? null
    this.env = init.env ?? null
    this.description = init.description ?? null
    Object.freeze(this)
  }
}

export interface OperandInit {
  /** 'path' operands are cwd-resolved and routed; textual operands pass
   * through verbatim (never 'bool': an operand is a value by definition). */
  type?: ValueType
  /**
   * Flags that make this slot textual even though it is declared 'path'.
   * tar's `-x` turns the operands into member names rather than files, and
   * jq's `--args` turns them into positional string values, which is a
   * property of the line, not of the slot, so it cannot be spelled in the
   * type alone. The flag reaches every operand on the line, or only the ones
   * typed after it for a program that files each operand as it reads it
   * (IN_ORDER_OPERANDS, jq).
   */
  textWhen?: readonly string[]
  /**
   * Every word from this slot on is gathered verbatim, options included.
   * This is argparse's `nargs=argparse.REMAINDER` and POSIX's own option
   * order: the first operand ends option parsing, where GNU's default
   * permutes instead (`ls a -1` reads -1 as a flag, `POSIXLY_CORRECT=1
   * ls a -1` reads it as a filename). Set it for a command that
   * dispatches to another program, which is the case argparse documents
   * it for: python3's script and the words after it are the script's
   * argv, so `python3 s.py --foo` must hand --foo over untouched while
   * `python3 -zz s.py` must still refuse -zz as python3's own.
   */
  remainder?: boolean
  /**
   * Flags that supply this operand's value. When any is present the slot is
   * skipped and remaining args classify as rest (e.g. grep's pattern with
   * -e/-f). This is the declarative form of the conditional real tools write
   * by hand (grep's `if (!pattern_given)` getopt loop); the same scenario
   * clap names `required_unless_present` and docopt expresses as alternate
   * usage patterns. It lives in the spec, not in command code, because
   * Mirage classifies args before a backend is chosen.
   */
  providedBy?: readonly string[]
  /**
   * The slot's name in a usage line, bare (`PAGE_ID`, rendered `<PAGE_ID>`
   * when required and `[PAGE_ID]` when not); the brackets belong to the
   * renderer, which is the only thing that knows the dialect. Empty renders
   * the generic `<path>`/`<text>` placeholder the ordinary help uses.
   */
  name?: string
  /**
   * The line must supply this slot; one that does not is a usage error the
   * parser reports, rather than something each leaf re-discovers and words
   * its own way.
   */
  required?: boolean
}

export class Operand {
  readonly type: ValueType
  readonly providedBy: readonly string[]
  readonly textWhen: readonly string[]
  readonly name: string
  readonly required: boolean
  readonly remainder: boolean

  constructor(init: OperandInit = {}) {
    this.type = init.type ?? 'path'
    this.providedBy = Object.freeze([...(init.providedBy ?? [])])
    this.textWhen = Object.freeze([...(init.textWhen ?? [])])
    this.name = init.name ?? ''
    this.required = init.required ?? false
    this.remainder = init.remainder ?? false
    Object.freeze(this)
  }
}

/**
 * Init accepts every CommandSpec instance field at its instance type
 * (ignoreTokens as any iterable, description/epilog as null) so a spec
 * instance can be spread into a new one: `new CommandSpec({...spec, ...})`
 * is the TS mirror of Python's dataclasses.replace and carries fields
 * added later without hand-listing them.
 */
export interface CommandSpecInit {
  options?: readonly Option[]
  positional?: readonly Operand[]
  rest?: Operand | null
  ignoreTokens?: Iterable<string>
  description?: string | null
  epilog?: string | null
  oldOptionStyle?: boolean
  operandBase?: string | null
  allowAbbrev?: boolean
}

export class CommandSpec {
  readonly options: readonly Option[]
  readonly positional: readonly Operand[]
  readonly rest: Operand | null
  readonly ignoreTokens: ReadonlySet<string>
  readonly description: string | null
  readonly epilog: string | null
  // tar's old option style: a first word with no leading dash is a
  // cluster of option letters whose arguments follow as separate words
  // (`tar xzf a.tgz`). Expanded by expandOldStyle before any other
  // scanning; see oldstyle.ts for the rules and why only tar has it.
  readonly oldOptionStyle: boolean
  // The spelling of an option that changes directory for the path
  // operands typed AFTER it (tar's -C). Positional and cumulative, the
  // way a real chdir is: `tar -cf a.tar -C d1 x -C ../d2 y` reads d1/x
  // and d1/../d2/y. Only path operands and the option's own value move;
  // every other path-valued flag keeps resolving against the session
  // cwd, which is what GNU does with -f.
  readonly operandBase: string | null
  // argparse's `allow_abbrev`: whether an unambiguous prefix of a long
  // option stands for it. getopt_long and argparse both expand one by
  // default; clap and lexopt (ripgrep) do not, so a program parsed with
  // either declares false and `--pcr` is refused rather than read as
  // `--pcre2-unicode`.
  readonly allowAbbrev: boolean
  // python3's rule: parse options strictly until the first operand,
  // then take every remaining word verbatim. An interpreter needs both
  // halves at once -- an unknown flag before the script is a usage
  // error, while `python3 s.py --foo` must hand `--foo` to the script
  // -- and the free-text leniency that serves echo/bash can only
  // express the second.

  constructor(init: CommandSpecInit = {}) {
    this.options = Object.freeze([...(init.options ?? [])])
    this.positional = Object.freeze([...(init.positional ?? [])])
    this.rest = init.rest ?? null
    this.ignoreTokens = new ImmutableSet(init.ignoreTokens ?? [])
    this.description = init.description ?? null
    this.epilog = init.epilog ?? null
    this.oldOptionStyle = init.oldOptionStyle ?? false
    this.operandBase = init.operandBase ?? null
    this.allowAbbrev = init.allowAbbrev ?? true
    // A subclass (CLISpec) still has its own fields to assign, so only
    // freeze here when constructed directly; subclasses freeze themselves.
    if (new.target === CommandSpec) Object.freeze(this)
  }
}

// What the parser itself can put in the bag: it works on argv, so every
// value is still text, or the bool/number a flag's own shape implies.
export type ParsedFlagValue = string | boolean | number | string[]
// What a command receives. The executor recovers a PATH-typed value as the
// PathSpec of the word that spelled it (`parseFlags`), and the mount stamps
// its backend key (`Mount.runCommand`), so an error line can name the path
// as typed. The mixed list is the `pair` shape (jq's `--rawfile name file`).
// Mirrors Python's FlagValue.
export type FlagValue = ParsedFlagValue | PathSpec | PathSpec[] | (string | PathSpec)[]
