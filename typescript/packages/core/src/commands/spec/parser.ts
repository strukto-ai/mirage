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
import { type CompiledSpec, compileSpec, expandLong } from './compile.ts'
import { FLOAT_VALUE, flagKwargName, INT_VALUE, NUMERIC_SHORT } from './constants.ts'
import { type CommandSpec, type ValueType, ParsedArgs } from './types.ts'

// Record a value flag occurrence under its canonical dest. Both spellings
// of one option land on the same key, so the last occurrence wins
// regardless of spelling (GNU: `cp --update=all -u` is `--update=older`)
// and `multiple` options accumulate in true command-line order
// (`sort -k1 --key=2` is `[1, 2]`).
function setValueFlag(
  flags: Record<string, string | boolean | number | string[]>,
  cs: CompiledSpec,
  spelling: string,
  value: string,
): void {
  const name = cs.destOf(spelling)
  if (cs.multipleDests.has(name)) {
    const prev = flags[name]
    if (Array.isArray(prev)) {
      prev.push(value)
    } else {
      flags[name] = [value]
    }
  } else {
    flags[name] = value
  }
}

// Record a boolean flag occurrence under its canonical dest. A count flag
// accumulates occurrences into a number (`-vvv` and `-v -v -v` both land
// as 3); every other boolean flag is sticky true.
function setBoolFlag(
  flags: Record<string, string | boolean | number | string[]>,
  cs: CompiledSpec,
  spelling: string,
): void {
  const name = cs.destOf(spelling)
  if (cs.countDests.has(name)) {
    const prev = flags[name]
    flags[name] = typeof prev === 'number' ? prev + 1 : 1
  } else {
    flags[name] = true
  }
}

interface MixedCluster {
  bools: string[]
  valueFlag: string
  attached: string | null
}

// getopt-style cluster of bool flags ending in a value flag, e.g. -ne / -nepat.
// Returns null when any character is unknown or no value flag terminates it.
function matchMixedCluster(tok: string, cs: CompiledSpec): MixedCluster | null {
  const bools: string[] = []
  const chars = tok.slice(1)
  for (let idx = 0; idx < chars.length; idx++) {
    const ch = chars[idx]
    if (ch === undefined) break
    const name = `-${ch}`
    if (cs.boolSpellings.has(name)) {
      bools.push(name)
      continue
    }
    if (cs.valueSpellings.includes(name)) {
      const rest = chars.slice(idx + 1)
      return { bools, valueFlag: name, attached: rest.length > 0 ? rest : null }
    }
    return null
  }
  return null
}

export function parseCommand(spec: CommandSpec, argv: string[], cwd: string): ParsedArgs {
  const cs = compileSpec(spec)

  const cachePaths: string[] = []
  const filteredArgv: string[] = []
  // origIndices[j] = argv position of filteredArgv[j]
  const origIndices: number[] = []
  let i = 0
  while (i < argv.length) {
    const cur = argv[i]
    if (cur === '--cache') {
      i += 1
      for (;;) {
        const next = argv[i]
        if (next === undefined || next.startsWith('-')) break
        cachePaths.push(resolvePath(next, cwd))
        i += 1
      }
    } else {
      if (cur !== undefined) {
        filteredArgv.push(cur)
        origIndices.push(i)
      }
      i += 1
    }
  }

  const flags: Record<string, string | boolean | number | string[]> = {}
  const rawArgs: string[] = []
  // rawIndices[k] = argv position of rawArgs[k]
  const rawIndices: number[] = []
  // Per-position operand kinds aligned with the caller's argv (null =
  // flag token or ignored word). Positions, not value sets, so the
  // same word can be TEXT in one slot and PATH in another:
  //   grep  *.txt  *.txt               -> [TEXT, PATH]
  //   find  /data  -name  *.txt        -> [PATH, null, TEXT]
  //   grep  --cache  /c  pat  f.txt    -> [null, null, TEXT, PATH]
  // origIndices/rawIndices map the parser's shrunken views back to
  // argv slots (filteredArgv drops --cache tokens, rawArgs keeps only
  // operands); kinds must be written at the original positions or one
  // dropped token shifts every later kind onto the wrong word.
  const wordKinds: (ValueType | null)[] = new Array<ValueType | null>(argv.length).fill(null)
  const warnings: string[] = []
  const invalidOptions: string[] = []
  const ambiguousOptions: [string, readonly string[]][] = []
  const optionErrorKinds: string[] = []
  const needsValueOptions: string[] = []
  // Free-text commands (echo/python/bash-style TEXT rest) keep unknown dash
  // tokens verbatim; elsewhere they are dropped with a warning so a stray
  // flag never corrupts pattern/path classification.
  const lenientDashOperands = cs.restKind !== null && cs.restKind !== 'path'
  i = 0
  let endOfFlags = false

  while (i < filteredArgv.length) {
    const tok = filteredArgv[i]
    if (tok === undefined) break

    if (!endOfFlags && spec.ignoreTokens.has(tok)) {
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
      rawIndices.push(origIndices[i] ?? -1)
      i += 1
      continue
    }

    if (tok.startsWith('--')) {
      // getopt_long: an exact spelling always wins; otherwise an
      // unambiguous prefix expands to its declared spelling (grep --rec)
      // and an ambiguous one is refused with every possibility.
      // Free-text commands keep exact-only matching: their unknown dash
      // tokens are operands, not typos.
      const eqPos = tok.indexOf('=')
      const typed = eqPos === -1 ? tok : tok.slice(0, eqPos)
      let spelling = typed
      if (!cs.dest.has(typed) && !lenientDashOperands) {
        const candidates = expandLong(cs, typed)
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
      } else if (isPair && eqPos === -1 && i + 2 < filteredArgv.length) {
        // Two tokens, both recorded under the one dest, so the command
        // reads the accumulated list in twos.
        setValueFlag(flags, cs, spelling, filteredArgv[i + 1] ?? '')
        setValueFlag(flags, cs, spelling, filteredArgv[i + 2] ?? '')
        // The first token names the value and is always textual; the
        // option's own kind describes the second.
        wordKinds[origIndices[i + 1] ?? -1] = 'str'
        wordKinds[origIndices[i + 2] ?? -1] = cs.kindOf.get(spelling) ?? null
        i += 3
      } else if (!isPair && cs.longValueSpellings.has(etok) && i + 1 < filteredArgv.length) {
        setValueFlag(flags, cs, etok, filteredArgv[i + 1] ?? '')
        wordKinds[origIndices[i + 1] ?? -1] = cs.kindOf.get(etok) ?? null
        i += 2
      } else if (isPair) {
        if (eqPos === -1) {
          needsValueOptions.push(spelling)
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
          setValueFlag(flags, cs, spelling, tok.slice(eqPos + 1))
        } else if (cs.longValueSpellings.has(etok)) {
          // Declared value flag at end of line with no argument.
          needsValueOptions.push(etok)
        } else if (lenientDashOperands) {
          rawArgs.push(tok)
          rawIndices.push(origIndices[i] ?? -1)
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
          setValueFlag(flags, cs, vf, tok.slice(vf.length))
          i += 1
          matchedOptional = true
          break
        }
      }
      if (matchedOptional) continue
      let matchedValue = false
      for (const vf of cs.valueSpellings) {
        if (tok === vf && i + 1 < filteredArgv.length) {
          setValueFlag(flags, cs, vf, filteredArgv[i + 1] ?? '')
          wordKinds[origIndices[i + 1] ?? -1] = cs.kindOf.get(vf) ?? null
          i += 2
          matchedValue = true
          break
        }
        if (tok.startsWith(vf) && tok.length > vf.length) {
          setValueFlag(flags, cs, vf, tok.slice(vf.length))
          i += 1
          matchedValue = true
          break
        }
      }
      if (matchedValue) continue

      if (cs.boolSpellings.has(tok)) {
        setBoolFlag(flags, cs, tok)
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
          for (const name of mixed.bools) setBoolFlag(flags, cs, name)
          setValueFlag(flags, cs, mixed.valueFlag, mixed.attached)
          i += 1
          continue
        }
        if (i + 1 < filteredArgv.length) {
          for (const name of mixed.bools) setBoolFlag(flags, cs, name)
          setValueFlag(flags, cs, mixed.valueFlag, filteredArgv[i + 1] ?? '')
          wordKinds[origIndices[i + 1] ?? -1] = cs.kindOf.get(mixed.valueFlag) ?? null
          i += 2
          continue
        }
      }

      if (lenientDashOperands || NUMERIC_SHORT.test(tok)) {
        rawArgs.push(tok)
        rawIndices.push(origIndices[i] ?? -1)
      } else if (cs.valueSpellings.includes(tok)) {
        // A declared value flag with no argument left on the line.
        needsValueOptions.push(tok.slice(1))
      } else if (mixed !== null && mixed.attached === null) {
        // A cluster ending in a value flag that ran out of line.
        needsValueOptions.push(mixed.valueFlag.slice(1))
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
    rawIndices.push(origIndices[i] ?? -1)
    i += 1
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

  // Int-typed values are refused before choices, argparse's order (type
  // conversion runs before the choices test). The bare boolean form of
  // an optional-value flag is exempt, like choices.
  const invalidIntOptions: [string, string][] = []
  for (const destName of cs.intDests) {
    const value = flags[destName]
    const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    for (const part of candidates) {
      if (!INT_VALUE.test(part)) invalidIntOptions.push([destName, part])
    }
  }
  const invalidFloatOptions: [string, string][] = []
  for (const destName of cs.floatDests) {
    const value = flags[destName]
    const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    for (const part of candidates) {
      if (!FLOAT_VALUE.test(part)) invalidFloatOptions.push([destName, part])
    }
  }

  const invalidValueOptions: [string, string, readonly string[]][] = []
  for (const [destName, allowed] of cs.choicesByDest) {
    const value = flags[destName]
    // The bare boolean form of an optional-value flag is exempt.
    const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    for (const part of candidates) {
      if (!allowed.includes(part)) invalidValueOptions.push([destName, part, allowed])
    }
  }

  const missingRequiredOptions = cs.requiredDests.filter((destName) => !(destName in flags))

  const positional: ValueType[] = spec.positional
    .filter((op) => !op.providedBy.some((name) => cs.destOf(name) in flags))
    .map((op) => op.type)

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
      classified.push([resolvePath(arg, cwd), 'path'])
      rawOperands.push([arg, 'path'])
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
      const resolvedList = val.map((part) => resolvePath(part, cwd))
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

  return new ParsedArgs({
    flags,
    args: classified,
    cachePaths,
    pathFlagValues,
    rawOperands,
    textFlagValues,
    warnings,
    invalidOptions,
    ambiguousOptions,
    optionErrorKinds,
    needsValueOptions,
    invalidValueOptions,
    invalidIntOptions,
    invalidFloatOptions,
    missingRequiredOptions,
    wordKinds,
  })
}

export function parseToKwargs(
  parsed: ParsedArgs,
): Record<string, string | boolean | number | string[]> {
  const result: Record<string, string | boolean | number | string[]> = {}
  for (const [key, value] of Object.entries(parsed.flags)) {
    result[flagKwargName(key)] = value
  }
  return result
}
