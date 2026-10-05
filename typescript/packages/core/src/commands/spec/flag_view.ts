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

import { flagKwargName, OPERAND, REFUSED, SPELLED } from './constants.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { PathSpec } from '../../types.ts'
import type { CommandSpec, FlagValue, ParsedFlagValue } from './types.ts'

// The tape records what the parser scanned, so its values are the parser's
// own; a PATH value recovered as a PathSpec replaces the bag entry only. It
// holds each option occurrence as [dest, value], each operand as [OPERAND,
// word], for a program that runs its own option loop each refused option as
// [REFUSED, word], and each SPELLED_WORDS word as [SPELLED, word], so it also
// says which options were typed before an operand or a refusal.
const occurrenceTapes = new WeakMap<Record<string, FlagValue>, [string, ParsedFlagValue][]>()

// The tape names no option declares: they mark operands, refusals and spelled
// words.
const TAPE_ONLY: ReadonlySet<string> = new Set([OPERAND, REFUSED, SPELLED])

export function flagOccurrences(flags: Record<string, FlagValue>): [string, ParsedFlagValue][] {
  let tape = occurrenceTapes.get(flags)
  if (tape === undefined) {
    tape = []
    occurrenceTapes.set(flags, tape)
  }
  return tape
}

/**
 * The flags with each operand's tape entry spread over its words.
 *
 * The parse runs before a glob expands, so the tape holds an operand as it
 * was typed. A program that reads its operands in order (join) needs each
 * match where the glob stood, as its argv would hold them. A tape that does
 * not place exactly these operands is kept as it is. Mirrors Python's
 * `spread_operands`.
 */
export function spreadOperands(
  flags: Record<string, FlagValue>,
  groups: readonly (readonly string[])[],
): Record<string, FlagValue> {
  const out = { ...flags }
  const tape = flagOccurrences(flags)
  const placed = tape.filter(([name]) => name === OPERAND).length
  const words = groups[Symbol.iterator]()
  flagOccurrences(out).push(
    ...(placed !== groups.length
      ? tape
      : tape.flatMap(([name, value]): [string, ParsedFlagValue][] =>
          name === OPERAND
            ? (words.next().value ?? []).map((word): [string, ParsedFlagValue] => [OPERAND, word])
            : [[name, value]],
        )),
  )
  return out
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
          `(known: ${[...this.allowed].sort(compareCodePoints).join(', ')})`,
      )
    }
    return name
  }

  /**
   * The given flag names, ordered by their recorded occurrences.
   *
   * The parser fills the bag in scan order and every hop between
   * (object spreads, copies) preserves string-key insertion order, so
   * a key's position is its last occurrence for scalars, first for accumulating options; a flag
   * supplied by a default or the environment lands after every typed
   * one. Names the line never carried are dropped. This is what an
   * order-sensitive option family (grep's --include/--exclude, where
   * the later kind overrides the earlier) reads, since the bag has no
   * per-occurrence positions.
   */
  typedOrder(...names: string[]): string[] {
    const wanted = new Set(names.map((n) => this.key(n)))
    return Object.keys(this.flags).filter((k) => wanted.has(k))
  }

  /**
   * Read each typed occurrence, then defaults without a typed value.
   *
   * OPERAND among the names reads the operands too, each as [OPERAND, word]
   * where it was typed among the options, and REFUSED and SPELLED read the
   * refused options and the spelled words the same way. Flags with no tape (a
   * plain record) have none of them.
   */
  occurrences(...names: string[]): [string, ParsedFlagValue][] {
    const wanted = new Set(names.map((name) => (TAPE_ONLY.has(name) ? name : this.key(name))))
    const result = flagOccurrences(this.flags).filter(
      ([name]) => wanted.has(name) && (TAPE_ONLY.has(name) || name in this.flags),
    )
    const seen = new Set(result.map(([name]) => name))
    for (const name of this.typedOrder(...names.filter((name) => !TAPE_ONLY.has(name)))) {
      if (seen.has(name)) continue
      const value = this.flags[name]
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) {
        result.push([name, item instanceof PathSpec ? item.virtual : item])
      }
    }
    return result
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

  asFloat(name: string): number | undefined {
    const value = this.flags[this.key(name)]
    if (typeof value === 'number') return value
    if (typeof value !== 'string') return undefined
    // All-or-nothing like Python's float(), mirroring asInt: parseFloat
    // would take the numeric prefix of '2.5x' and hand back NaN for
    // 'abc', and NaN still satisfies `number`.
    const text = value.trim()
    if (
      !/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(
        text,
      )
    ) {
      throw new Error(`flag '${name}' expects a number, got '${value}'`)
    }
    return Number.parseFloat(text.replaceAll('_', ''))
  }

  // A PATH-typed value reads as its resolved virtual path here, which is
  // what every reader of the string wants; `asPaths` hands over the PathSpec
  // itself, for the typed spelling an error line names.
  asStr(name: string): string | undefined {
    const value = this.flags[this.key(name)]
    if (value instanceof PathSpec) return value.virtual
    return typeof value === 'string' ? value : undefined
  }

  asList(name: string): string[] {
    const value = this.flags[this.key(name)]
    if (Array.isArray(value)) return value.map((v) => (v instanceof PathSpec ? v.virtual : v))
    if (value instanceof PathSpec) return [value.virtual]
    if (typeof value === 'string') return [value]
    return []
  }

  // PATH-typed flag values arrive as PathSpec. Mirrors Python's `as_paths`.
  asPaths(name: string): PathSpec[] {
    const value = this.flags[this.key(name)]
    if (Array.isArray(value)) {
      const items: readonly (string | PathSpec)[] = value
      return items.filter((v): v is PathSpec => v instanceof PathSpec)
    }
    if (value instanceof PathSpec) return [value]
    return []
  }

  raw(name: string): FlagValue | undefined {
    return this.flags[this.key(name)]
  }
}
