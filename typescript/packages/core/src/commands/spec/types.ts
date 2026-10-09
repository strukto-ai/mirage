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

// Shared parser value kinds. Argument declarations use str/int/float/path;
// zero-token actions lower to the internal bool kind.
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

export type ArgumentAction = 'store' | 'store_true' | 'count' | 'append' | 'extend'
export type Nargs = number | '?' | '*' | '+' | 'REMAINDER' | null

export interface ArgumentInit {
  type?: ValueType
  action?: ArgumentAction
  nargs?: Nargs
  choices?: readonly string[]
  required?: boolean
  default?: string | null
  metavar?: string | null
  env?: string | null
  help?: string | null
  numericShorthand?: boolean
  shortValue?: boolean
  attachedOnly?: boolean
  providedBy?: readonly string[]
  textWhen?: readonly string[]
  valueTypes?: readonly ValueType[]
}

/** An option spelling or positional destination, using argparse actions and arity. */
export class Argument {
  readonly names: readonly string[]
  readonly type: ValueType
  readonly action: ArgumentAction
  readonly nargs: Nargs
  readonly choices: readonly string[]
  readonly required: boolean
  readonly default: string | null
  readonly metavar: string | null
  readonly env: string | null
  readonly help: string | null
  readonly numericShorthand: boolean
  readonly shortValue: boolean
  readonly attachedOnly: boolean
  readonly providedBy: readonly string[]
  readonly textWhen: readonly string[]
  readonly valueTypes: readonly ValueType[]

  constructor(names: string | readonly string[], init: ArgumentInit = {}) {
    this.names = Object.freeze(typeof names === 'string' ? [names] : [...names])
    this.type = init.type ?? 'str'
    this.action = init.action ?? 'store'
    this.nargs = init.nargs ?? null
    this.choices = Object.freeze([...(init.choices ?? [])])
    this.required = init.required ?? false
    this.default = init.default ?? null
    this.metavar = init.metavar ?? null
    this.env = init.env ?? null
    this.help = init.help ?? null
    this.numericShorthand = init.numericShorthand ?? false
    this.shortValue = init.shortValue ?? true
    this.attachedOnly = init.attachedOnly ?? false
    this.providedBy = Object.freeze([...(init.providedBy ?? [])])
    this.textWhen = Object.freeze([...(init.textWhen ?? [])])
    this.valueTypes = Object.freeze([...(init.valueTypes ?? [])])
    Object.freeze(this)
  }
}

export interface CommandSpecInit {
  name?: string
  aliases?: readonly string[]
  arguments?: readonly Argument[]
  subcommands?: readonly CommandSpec[]
  usageStyle?: UsageStyle
  addHelp?: boolean
  ignoreTokens?: Iterable<string>
  description?: string | null
  epilog?: string | null
  oldOptionStyle?: boolean
  operandBase?: string | null
  allowAbbrev?: boolean
}

/** A command grammar, including optional subcommands, independent of execution. */
export class CommandSpec {
  readonly name: string
  readonly aliases: readonly string[]
  readonly arguments: readonly Argument[]
  readonly subcommands: readonly CommandSpec[]
  readonly usageStyle: UsageStyle
  readonly addHelp: boolean
  readonly ignoreTokens: ReadonlySet<string>
  readonly description: string | null
  readonly epilog: string | null
  readonly oldOptionStyle: boolean
  readonly operandBase: string | null
  readonly allowAbbrev: boolean

  constructor(init: CommandSpecInit = {}) {
    this.name = init.name ?? ''
    this.aliases = Object.freeze([...(init.aliases ?? [])])
    this.arguments = Object.freeze([...(init.arguments ?? [])])
    this.subcommands = Object.freeze([...(init.subcommands ?? [])])
    this.usageStyle = init.usageStyle ?? UsageStyle.ARGPARSE
    this.addHelp = init.addHelp ?? true
    this.ignoreTokens = new ImmutableSet(init.ignoreTokens ?? [])
    this.description = init.description ?? null
    this.epilog = init.epilog ?? null
    this.oldOptionStyle = init.oldOptionStyle ?? false
    this.operandBase = init.operandBase ?? null
    this.allowAbbrev = init.allowAbbrev ?? true
    Object.freeze(this)
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
