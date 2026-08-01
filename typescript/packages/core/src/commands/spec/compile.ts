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

import { type CommandSpec, OperandKind } from './types.ts'

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
  /** Value kind per spelling (parse-time lookup). */
  readonly kindOf: ReadonlyMap<string, OperandKind>
  /** Value kind per canonical spelling, for post-parse PATH/TEXT value
   * collection. */
  readonly kindByDest: ReadonlyMap<string, OperandKind>
  /** Spelling -> canonical spelling. */
  readonly dest: ReadonlyMap<string, string>
  /** Canonical spellings that accumulate repeated values into a list. */
  readonly multipleDests: ReadonlySet<string>
  /** Canonical spelling fed by the `-<digits>` shorthand, when one
   * option declares it. */
  readonly numericDest: string | null
  /** Kind of the rest operand. */
  readonly restKind: OperandKind | null

  constructor(fields: {
    boolSpellings: ReadonlySet<string>
    valueSpellings: readonly string[]
    attachSpellings: readonly string[]
    longBoolSpellings: ReadonlySet<string>
    longValueSpellings: ReadonlySet<string>
    longOptionalSpellings: ReadonlySet<string>
    kindOf: ReadonlyMap<string, OperandKind>
    kindByDest: ReadonlyMap<string, OperandKind>
    dest: ReadonlyMap<string, string>
    multipleDests: ReadonlySet<string>
    numericDest: string | null
    restKind: OperandKind | null
  }) {
    this.boolSpellings = fields.boolSpellings
    this.valueSpellings = fields.valueSpellings
    this.attachSpellings = fields.attachSpellings
    this.longBoolSpellings = fields.longBoolSpellings
    this.longValueSpellings = fields.longValueSpellings
    this.longOptionalSpellings = fields.longOptionalSpellings
    this.kindOf = fields.kindOf
    this.kindByDest = fields.kindByDest
    this.dest = fields.dest
    this.multipleDests = fields.multipleDests
    this.numericDest = fields.numericDest
    this.restKind = fields.restKind
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
  const kindOf = new Map<string, OperandKind>()
  const kindByDest = new Map<string, OperandKind>()
  const dest = new Map<string, string>()
  const multipleDests = new Set<string>()
  let numericDest: string | null = null

  for (const opt of spec.options) {
    const canonical = opt.long ?? opt.short
    if (canonical === null) continue
    if (opt.short !== null) dest.set(opt.short, canonical)
    if (opt.long !== null) dest.set(opt.long, canonical)
    if (opt.valueKind !== OperandKind.NONE) kindByDest.set(canonical, opt.valueKind)
    if (opt.repeatable) multipleDests.add(canonical)

    if (opt.short !== null) {
      if (opt.valueKind === OperandKind.NONE) {
        boolSpellings.add(opt.short)
      } else if (opt.valueOptional) {
        // GNU optional argument: the bare short is boolean and a value
        // only rides attached to the same token.
        boolSpellings.add(opt.short)
        if (opt.shortValue) attachSpellings.push(opt.short)
        kindOf.set(opt.short, opt.valueKind)
      } else {
        valueSpellings.push(opt.short)
        kindOf.set(opt.short, opt.valueKind)
        if (opt.numericShorthand) numericDest = canonical
      }
    }
    if (opt.long !== null) {
      if (opt.valueKind === OperandKind.NONE) {
        longBoolSpellings.add(opt.long)
      } else if (opt.valueOptional) {
        // GNU optional argument: bare form is boolean, value only
        // attaches via `=`; a detached next token is an operand.
        longBoolSpellings.add(opt.long)
        longOptionalSpellings.add(opt.long)
        kindOf.set(opt.long, opt.valueKind)
      } else {
        longValueSpellings.add(opt.long)
        kindOf.set(opt.long, opt.valueKind)
      }
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
    kindOf,
    kindByDest,
    dest,
    multipleDests,
    numericDest,
    restKind: spec.rest !== null ? spec.rest.kind : null,
  })
  CACHE.set(spec, compiled)
  return compiled
}
