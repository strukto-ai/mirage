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

import { flagKwargName } from './constants.ts'

// Command names the spec layer references by value. Not a registry of
// every command: only names that appear away from their own module
// (usage message shapes, arity guards). Members are their plain string
// values, so the raw string the executor passes still matches. Mirrors
// the Python CommandName StrEnum and the crossmount Cmd pattern.
export enum CommandName {
  BASE64 = 'base64',
  CMP = 'cmp',
  COMM = 'comm',
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
  UNIQ = 'uniq',
  XXD = 'xxd',
}

export const OperandKind = Object.freeze({
  NONE: 'none',
  PATH: 'path',
  TEXT: 'text',
} as const)

export type OperandKind = (typeof OperandKind)[keyof typeof OperandKind]

export interface OptionInit {
  /** Short form, e.g. "-e". */
  short?: string | null
  /** Long form, e.g. "--max-depth". */
  long?: string | null
  /**
   * NONE for boolean flags; TEXT or PATH for value flags. PATH values are
   * cwd-resolved and routed for mount dispatch.
   */
  valueKind?: OperandKind
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
   * argparse `type=` as data. "int" makes the parser refuse a non-integer
   * value at parse time (argparse's `invalid int value`; the walk uses
   * git's `expects a numerical value`), before the command runs. The
   * accepted shape is an optional sign plus digits, the portable core of
   * Python int() and argparse. The bag still holds the string: commands
   * read it through FlagView.asInt, the established mirage convention.
   * Builtins whose GNU tool words its own numeric refusal (`head: invalid
   * number of lines`) keep "str" and validate in the command.
   */
  type?: 'str' | 'int'
  description?: string
}

export class Option {
  readonly short: string | null
  readonly long: string | null
  readonly valueKind: OperandKind
  readonly numericShorthand: boolean
  readonly count: boolean
  readonly multiple: boolean
  readonly valueOptional: boolean
  readonly shortValue: boolean
  readonly choices: readonly string[]
  readonly required: boolean
  readonly default: string | null
  readonly type: 'str' | 'int'
  readonly description: string | null

  constructor(init: OptionInit = {}) {
    this.short = init.short ?? null
    this.long = init.long ?? null
    this.valueKind = init.valueKind ?? OperandKind.NONE
    this.numericShorthand = init.numericShorthand ?? false
    this.count = init.count ?? false
    this.multiple = init.multiple ?? false
    this.valueOptional = init.valueOptional ?? false
    this.shortValue = init.shortValue ?? true
    this.choices = init.choices ?? []
    this.required = init.required ?? false
    this.default = init.default ?? null
    this.type = init.type ?? 'str'
    this.description = init.description ?? null
    Object.freeze(this)
  }
}

export interface OperandInit {
  /** PATH operands are cwd-resolved and routed; TEXT pass through verbatim. */
  kind?: OperandKind
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
}

export class Operand {
  readonly kind: OperandKind
  readonly providedBy: readonly string[]

  constructor(init: OperandInit = {}) {
    this.kind = init.kind ?? OperandKind.PATH
    this.providedBy = init.providedBy ?? []
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
}

export class CommandSpec {
  readonly options: readonly Option[]
  readonly positional: readonly Operand[]
  readonly rest: Operand | null
  readonly ignoreTokens: ReadonlySet<string>
  readonly description: string | null
  readonly epilog: string | null

  constructor(init: CommandSpecInit = {}) {
    this.options = init.options ?? []
    this.positional = init.positional ?? []
    this.rest = init.rest ?? null
    this.ignoreTokens = new Set(init.ignoreTokens ?? [])
    this.description = init.description ?? null
    this.epilog = init.epilog ?? null
    // A subclass (CLISpec) still has its own fields to assign, so only
    // freeze here when constructed directly; subclasses freeze themselves.
    if (new.target === CommandSpec) Object.freeze(this)
  }
}

export interface ParsedArgsInit {
  flags: Record<string, string | boolean | number | string[]>
  args: [string, OperandKind][]
  cachePaths?: string[]
  pathFlagValues?: string[]
  rawOperands?: [string, OperandKind][]
  textFlagValues?: string[]
  warnings?: string[]
  wordKinds?: (OperandKind | null)[]
  invalidOptions?: string[]
  ambiguousOptions?: [string, readonly string[]][]
  needsValueOptions?: string[]
  invalidValueOptions?: [string, string, readonly string[]][]
  invalidIntOptions?: [string, string][]
  missingRequiredOptions?: string[]
}

export class ParsedArgs {
  readonly flags: Record<string, string | boolean | number | string[]>
  readonly args: [string, OperandKind][]
  readonly cachePaths: string[]
  readonly pathFlagValues: string[]
  readonly rawOperands: [string, OperandKind][]
  readonly textFlagValues: string[]
  readonly warnings: string[]
  readonly wordKinds: (OperandKind | null)[]
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
  readonly needsValueOptions: string[]
  readonly invalidValueOptions: [string, string, readonly string[]][]
  readonly invalidIntOptions: [string, string][]
  readonly missingRequiredOptions: string[]

  constructor(init: ParsedArgsInit) {
    this.flags = init.flags
    this.args = init.args
    this.cachePaths = init.cachePaths ?? []
    this.pathFlagValues = init.pathFlagValues ?? []
    this.rawOperands = init.rawOperands ?? []
    this.textFlagValues = init.textFlagValues ?? []
    this.warnings = init.warnings ?? []
    this.wordKinds = init.wordKinds ?? []
    this.invalidOptions = init.invalidOptions ?? []
    this.ambiguousOptions = init.ambiguousOptions ?? []
    this.needsValueOptions = init.needsValueOptions ?? []
    this.invalidValueOptions = init.invalidValueOptions ?? []
    this.invalidIntOptions = init.invalidIntOptions ?? []
    this.missingRequiredOptions = init.missingRequiredOptions ?? []
  }

  paths(): string[] {
    return this.args.filter(([, k]) => k === OperandKind.PATH).map(([v]) => v)
  }

  routingPaths(): string[] {
    return [...this.paths(), ...this.pathFlagValues]
  }

  texts(): string[] {
    return this.args.filter(([, k]) => k === OperandKind.TEXT).map(([v]) => v)
  }

  flag(
    name: string,
    fallback: string | boolean | number | string[] | null = null,
  ): string | boolean | number | string[] | null {
    return this.flags[name] ?? fallback
  }
}

/**
 * Collect the kwarg names a spec's options can produce.
 *
 * One name per option: the long spelling when an option declares both,
 * matching the parser's canonical dest. Keeping the short spelling here
 * too would let a stale `fl.asBool('a')` stay legal and read false
 * forever after dest unification; canonical-only turns that silent miss
 * into a throw. Mirrors Python's `spec_flag_names`.
 */
export function specFlagNames(spec: CommandSpec): ReadonlySet<string> {
  const names = new Set<string>()
  for (const option of spec.options) {
    const canonical = option.long ?? option.short
    if (canonical !== null) names.add(flagKwargName(canonical))
  }
  return names
}

export type FlagValue = string | boolean | number | string[]

/**
 * Typed read-only view over raw flag kwargs.
 *
 * Commands receive flags as an untyped record from the dispatcher; this
 * view is the one sanctioned way to read them, replacing ad-hoc
 * `flags.x === true` checks and typeof chains. Mirrors Python's
 * `FlagView`.
 *
 * When constructed with a spec, reading a name the spec does not declare
 * throws. A missing key is otherwise indistinguishable from "flag not
 * passed", so a typo in the name would silently read as false/undefined.
 */
export class FlagView {
  private readonly flags: Readonly<Record<string, FlagValue>>
  private readonly allowed: ReadonlySet<string> | null

  constructor(flags?: Readonly<Record<string, FlagValue>>, spec?: CommandSpec) {
    this.flags = flags ?? {}
    this.allowed = spec === undefined ? null : specFlagNames(spec)
  }

  private key(name: string): string {
    if (this.allowed !== null && !this.allowed.has(name)) {
      throw new Error(
        `flag '${name}' is not declared by the command spec ` +
          `(known: ${[...this.allowed].sort().join(', ')})`,
      )
    }
    return name
  }

  asBool(name: string): boolean {
    const value = this.flags[this.key(name)]
    if (typeof value === 'boolean') return value
    // A count flag holds a number; any occurrence reads as set.
    return typeof value === 'number' && value > 0
  }

  asInt(name: string): number | undefined {
    const value = this.flags[this.key(name)]
    if (typeof value === 'number') return value
    if (typeof value !== 'string') return undefined
    // Python's int() is all-or-nothing: it accepts surrounding whitespace
    // and underscore separators and raises on anything else. parseInt would
    // instead take the numeric prefix of '5x' and hand back NaN for 'abc',
    // and NaN still satisfies `number`, so a bad value would flow onward as
    // a number rather than being rejected.
    const text = value.trim()
    if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) {
      throw new Error(`flag '${name}' expects an integer, got '${value}'`)
    }
    return Number.parseInt(text.replaceAll('_', ''), 10)
  }

  asStr(name: string): string | undefined {
    const value = this.flags[this.key(name)]
    return typeof value === 'string' ? value : undefined
  }

  asList(name: string): string[] {
    const value = this.flags[this.key(name)]
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
    if (typeof value === 'string') return [value]
    return []
  }

  raw(name: string): FlagValue | undefined {
    return this.flags[this.key(name)]
  }
}
