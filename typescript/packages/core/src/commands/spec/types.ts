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
   * Repeated occurrences accumulate newline-joined instead of last-wins
   * (POSIX pattern-list form, e.g. grep -e). Repeatable PATH flags resolve
   * and route each joined path.
   */
  repeatable?: boolean
  description?: string
}

export class Option {
  readonly short: string | null
  readonly long: string | null
  readonly valueKind: OperandKind
  readonly numericShorthand: boolean
  readonly repeatable: boolean
  readonly description: string | null

  constructor(init: OptionInit = {}) {
    this.short = init.short ?? null
    this.long = init.long ?? null
    this.valueKind = init.valueKind ?? OperandKind.NONE
    this.numericShorthand = init.numericShorthand ?? false
    this.repeatable = init.repeatable ?? false
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

export interface CommandSpecInit {
  options?: readonly Option[]
  positional?: readonly Operand[]
  rest?: Operand | null
  ignoreTokens?: readonly string[]
  description?: string
}

export class CommandSpec {
  readonly options: readonly Option[]
  readonly positional: readonly Operand[]
  readonly rest: Operand | null
  readonly ignoreTokens: ReadonlySet<string>
  readonly description: string | null

  constructor(init: CommandSpecInit = {}) {
    this.options = init.options ?? []
    this.positional = init.positional ?? []
    this.rest = init.rest ?? null
    this.ignoreTokens = new Set(init.ignoreTokens ?? [])
    this.description = init.description ?? null
    Object.freeze(this)
  }
}

export interface ParsedArgsInit {
  flags: Record<string, string | boolean | string[]>
  args: [string, OperandKind][]
  cachePaths?: string[]
  pathFlagValues?: string[]
  rawOperands?: [string, OperandKind][]
  textFlagValues?: string[]
  warnings?: string[]
}

export class ParsedArgs {
  readonly flags: Record<string, string | boolean | string[]>
  readonly args: [string, OperandKind][]
  readonly cachePaths: string[]
  readonly pathFlagValues: string[]
  readonly rawOperands: [string, OperandKind][]
  readonly textFlagValues: string[]
  readonly warnings: string[]

  constructor(init: ParsedArgsInit) {
    this.flags = init.flags
    this.args = init.args
    this.cachePaths = init.cachePaths ?? []
    this.pathFlagValues = init.pathFlagValues ?? []
    this.rawOperands = init.rawOperands ?? []
    this.textFlagValues = init.textFlagValues ?? []
    this.warnings = init.warnings ?? []
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
    fallback: string | boolean | string[] | null = null,
  ): string | boolean | string[] | null {
    return this.flags[name] ?? fallback
  }
}
