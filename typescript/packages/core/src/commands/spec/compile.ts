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
import { type CommandSpec, type ValueType } from './types.ts'

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
export class CompiledSpec {
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
  /** Behavior signature per long spelling. Prefix candidates whose
   * signatures all match are one option in glibc's eyes (same action
   * struct), so the prefix resolves instead of refusing as ambiguous. */
  readonly longSignatures: ReadonlyMap<string, string>
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
  /** Canonical spellings that consume two tokens per occurrence and
   * accumulate both, flattened. */
  readonly pairDests: ReadonlySet<string>
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
  /** Canonical spelling fed by the `-<digits>` shorthand, when one
   * option declares it. */
  readonly numericDest: string | null
  /** Kind of the rest operand. */
  readonly restKind: ValueType | null
  // Canonical spelling of the option that re-bases the path operands
  // after it (CommandSpec.operandBase, tar's -C).
  readonly baseDest: string | null

  constructor(fields: {
    boolSpellings: ReadonlySet<string>
    valueSpellings: readonly string[]
    attachSpellings: readonly string[]
    longBoolSpellings: ReadonlySet<string>
    longValueSpellings: ReadonlySet<string>
    longOptionalSpellings: ReadonlySet<string>
    longSpellings: readonly string[]
    longSignatures: ReadonlyMap<string, string>
    intDests: ReadonlySet<string>
    floatDests: ReadonlySet<string>
    kindOf: ReadonlyMap<string, ValueType>
    kindByDest: ReadonlyMap<string, ValueType>
    dest: ReadonlyMap<string, string>
    multipleDests: ReadonlySet<string>
    pairDests: ReadonlySet<string>
    countDests: ReadonlySet<string>
    choicesByDest: ReadonlyMap<string, readonly string[]>
    requiredDests: readonly string[]
    defaults: ReadonlyMap<string, string>
    numericDest: string | null
    restKind: ValueType | null
    baseDest: string | null
  }) {
    this.boolSpellings = fields.boolSpellings
    this.valueSpellings = fields.valueSpellings
    this.attachSpellings = fields.attachSpellings
    this.longBoolSpellings = fields.longBoolSpellings
    this.longValueSpellings = fields.longValueSpellings
    this.longOptionalSpellings = fields.longOptionalSpellings
    this.longSpellings = fields.longSpellings
    this.longSignatures = fields.longSignatures
    this.intDests = fields.intDests
    this.floatDests = fields.floatDests
    this.kindOf = fields.kindOf
    this.kindByDest = fields.kindByDest
    this.dest = fields.dest
    this.multipleDests = fields.multipleDests
    this.pairDests = fields.pairDests
    this.countDests = fields.countDests
    this.choicesByDest = fields.choicesByDest
    this.requiredDests = fields.requiredDests
    this.defaults = fields.defaults
    this.numericDest = fields.numericDest
    this.restKind = fields.restKind
    this.baseDest = fields.baseDest
  }

  /** Canonical spelling for a typed spelling. */
  destOf(spelling: string): string {
    return this.dest.get(spelling) ?? spelling
  }
}

const CACHE = new WeakMap<CommandSpec, CompiledSpec>()

/** Lower a CommandSpec into parser lookup tables, cached per spec. */
export function compileSpec(spec: CommandSpec): CompiledSpec {
  const cached = CACHE.get(spec)
  if (cached !== undefined) return cached

  const boolSpellings = new Set<string>()
  const valueSpellings: string[] = []
  const attachSpellings: string[] = []
  const longBoolSpellings = new Set<string>()
  const longValueSpellings = new Set<string>()
  const longOptionalSpellings = new Set<string>()
  const longSpellings: string[] = []
  const longSignatures = new Map<string, string>()
  const intDests = new Set<string>()
  const floatDests = new Set<string>()
  const kindOf = new Map<string, ValueType>()
  const kindByDest = new Map<string, ValueType>()
  const dest = new Map<string, string>()
  const multipleDests = new Set<string>()
  const pairDests = new Set<string>()
  const countDests = new Set<string>()
  const choicesByDest = new Map<string, readonly string[]>()
  const requiredDests: string[] = []
  const defaults = new Map<string, string>()
  let numericDest: string | null = null

  for (const opt of spec.options) {
    const canonical = opt.long ?? opt.short
    if (canonical === null) continue
    if (opt.count && opt.type !== 'bool') {
      throw new Error(`option '${canonical}': count requires a boolean flag (valueKind NONE)`)
    }
    if (opt.pair && opt.type === 'bool') {
      throw new Error(
        `option '${canonical}': pair requires a value flag (a boolean consumes no token)`,
      )
    }
    if (opt.pair && opt.valueOptional) {
      throw new Error(`option '${canonical}': pair and valueOptional are mutually exclusive`)
    }
    if (opt.pair && opt.short !== null) {
      // A short spelling clusters and takes an attached value, both of
      // which are single-token rules; jq's own two-token options are
      // long-only for the same reason.
      throw new Error(`option '${canonical}': pair requires a long spelling only`)
    }
    if (opt.type === 'bool' && (opt.choices.length > 0 || opt.default !== null)) {
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
    if (opt.short !== null) dest.set(opt.short, canonical)
    if (opt.long !== null) dest.set(opt.long, canonical)
    if (opt.type !== 'bool') kindByDest.set(canonical, opt.type)
    if (opt.multiple || opt.pair) multipleDests.add(canonical)
    if (opt.pair) pairDests.add(canonical)
    if (opt.count) countDests.add(canonical)
    if (opt.choices.length > 0) choicesByDest.set(canonical, opt.choices)
    if (opt.required) requiredDests.push(canonical)
    if (opt.default !== null) defaults.set(canonical, opt.default)

    if (opt.short !== null) {
      if (opt.type === 'bool') {
        boolSpellings.add(opt.short)
      } else if (opt.valueOptional) {
        // GNU optional argument: the bare short is boolean and a value
        // only rides attached to the same token.
        boolSpellings.add(opt.short)
        if (opt.shortValue) attachSpellings.push(opt.short)
        kindOf.set(opt.short, opt.type)
      } else {
        valueSpellings.push(opt.short)
        kindOf.set(opt.short, opt.type)
        if (opt.numericShorthand) numericDest = canonical
      }
    }
    if (opt.long !== null) {
      longSpellings.push(opt.long)
      // Everything parsing-relevant except the spellings and the help
      // text: two options that agree here are one action.
      longSignatures.set(
        opt.long,
        [
          opt.type,
          String(opt.valueOptional),
          String(opt.multiple),
          String(opt.pair),
          String(opt.count),
          opt.choices.join(','),
          String(opt.required),
          String(opt.default),
        ].join('|'),
      )
      if (opt.type === 'bool') {
        longBoolSpellings.add(opt.long)
      } else if (opt.valueOptional) {
        // GNU optional argument: bare form is boolean, value only
        // attaches via `=`; a detached next token is an operand.
        longBoolSpellings.add(opt.long)
        longOptionalSpellings.add(opt.long)
        kindOf.set(opt.long, opt.type)
      } else {
        longValueSpellings.add(opt.long)
        kindOf.set(opt.long, opt.type)
      }
    }
  }

  let baseDest: string | null = null
  if (spec.operandBase !== null) {
    baseDest = dest.get(spec.operandBase) ?? null
    if (baseDest === null) {
      throw new Error(`operandBase '${spec.operandBase}' is not a declared option`)
    }
    if (kindByDest.get(baseDest) !== 'path' || pairDests.has(baseDest)) {
      throw new Error(`operandBase '${spec.operandBase}' must be a single-token path option`)
    }
  }

  // Longest first so an attached match can never be stolen by a shorter
  // spelling that happens to prefix it (-name vs -n).
  valueSpellings.sort((a, b) => b.length - a.length)
  attachSpellings.sort((a, b) => b.length - a.length)

  const compiled = new CompiledSpec({
    boolSpellings,
    valueSpellings,
    attachSpellings,
    longBoolSpellings,
    longValueSpellings,
    longOptionalSpellings,
    longSpellings,
    longSignatures,
    intDests,
    floatDests,
    kindOf,
    kindByDest,
    dest,
    multipleDests,
    pairDests,
    countDests,
    choicesByDest,
    requiredDests,
    defaults,
    numericDest,
    restKind: spec.rest !== null ? spec.rest.type : null,
    baseDest,
  })
  CACHE.set(spec, compiled)
  return compiled
}

/**
 * getopt_long prefix matching for a long spelling.
 *
 * An exact declared spelling always wins (GNU: `--binary` never trips
 * over `--binary-files`); otherwise the candidates are every declared
 * long the typed spelling prefixes. Candidates whose behavior signatures
 * all match count as one option, the way glibc treats several table
 * entries with one action struct (`grep --colo` resolves despite
 * `--color`/`--colour` being separate entries), and the prefix resolves
 * to the first. The result length tells the caller everything: 0
 * unknown, 1 match, 2+ ambiguous (every matching spelling in
 * declaration order, the order GNU lists possibilities, synonyms
 * included like GNU's own listing).
 */
export function expandLong(cs: CompiledSpec, spelling: string): readonly string[] {
  if (cs.dest.has(spelling)) return [spelling]
  if (spelling.length <= 2) return []
  const matches = cs.longSpellings.filter((declared) => declared.startsWith(spelling))
  const first = matches[0]
  if (first === undefined) return []
  const signatures = new Set(matches.map((declared) => cs.longSignatures.get(declared)))
  if (signatures.size === 1) return [first]
  return matches
}
