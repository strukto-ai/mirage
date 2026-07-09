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
import { AMBIGUOUS_NAMES, NUMERIC_SHORT } from './constants.ts'
import { type CommandSpec, OperandKind, ParsedArgs } from './types.ts'

function setValueFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string,
  repeatFlags: ReadonlySet<string>,
): void {
  if (repeatFlags.has(name)) {
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

interface MixedCluster {
  bools: string[]
  valueFlag: string
  attached: string | null
}

// getopt-style cluster of bool flags ending in a value flag, e.g. -ne / -nepat.
// Returns null when any character is unknown or no value flag terminates it.
function matchMixedCluster(
  tok: string,
  boolFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): MixedCluster | null {
  const bools: string[] = []
  const chars = tok.slice(1)
  for (let idx = 0; idx < chars.length; idx++) {
    const ch = chars[idx]
    if (ch === undefined) break
    const name = `-${ch}`
    if (boolFlags.has(name)) {
      bools.push(name)
      continue
    }
    if (valueFlags.has(name)) {
      const rest = chars.slice(idx + 1)
      return { bools, valueFlag: name, attached: rest.length > 0 ? rest : null }
    }
    return null
  }
  return null
}

export function parseCommand(spec: CommandSpec, argv: string[], cwd: string): ParsedArgs {
  const boolFlags = new Set<string>()
  const valueFlags = new Set<string>()
  const longBoolFlags = new Set<string>()
  const longValueFlags = new Set<string>()
  const valueFlagKinds = new Map<string, OperandKind>()
  const repeatFlags = new Set<string>()
  let numericShorthandFlag: string | null = null

  for (const opt of spec.options) {
    if (opt.short !== null) {
      if (opt.valueKind === OperandKind.NONE) {
        boolFlags.add(opt.short)
      } else {
        valueFlags.add(opt.short)
        valueFlagKinds.set(opt.short, opt.valueKind)
        if (opt.repeatable) repeatFlags.add(opt.short)
        if (opt.numericShorthand) numericShorthandFlag = opt.short
      }
    }
    if (opt.long !== null) {
      if (opt.valueKind === OperandKind.NONE) {
        longBoolFlags.add(opt.long)
      } else {
        longValueFlags.add(opt.long)
        valueFlagKinds.set(opt.long, opt.valueKind)
        if (opt.repeatable) repeatFlags.add(opt.long)
      }
    }
  }

  const restKind: OperandKind | null = spec.rest !== null ? spec.rest.kind : null

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

  const flags: Record<string, string | boolean | string[]> = {}
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
  const wordKinds: (OperandKind | null)[] = new Array<OperandKind | null>(argv.length).fill(null)
  const warnings: string[] = []
  // Free-text commands (echo/python/bash-style TEXT rest) keep unknown dash
  // tokens verbatim; elsewhere they are dropped with a warning so a stray
  // flag never corrupts pattern/path classification.
  const lenientDashOperands = restKind === OperandKind.TEXT
  i = 0
  let endOfFlags = false

  while (i < filteredArgv.length) {
    const tok = filteredArgv[i]
    if (tok === undefined) break

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
      if (longBoolFlags.has(tok)) {
        flags[tok] = true
        i += 1
      } else if (longValueFlags.has(tok) && i + 1 < filteredArgv.length) {
        setValueFlag(flags, tok, filteredArgv[i + 1] ?? '', repeatFlags)
        wordKinds[origIndices[i + 1] ?? -1] = valueFlagKinds.get(tok) ?? null
        i += 2
      } else {
        const eq = tok.indexOf('=')
        if (eq !== -1 && longValueFlags.has(tok.slice(0, eq))) {
          setValueFlag(flags, tok.slice(0, eq), tok.slice(eq + 1), repeatFlags)
        } else if (lenientDashOperands) {
          rawArgs.push(tok)
          rawIndices.push(origIndices[i] ?? -1)
        } else {
          warnings.push(`warning: unknown option '${tok}' ignored`)
        }
        i += 1
      }
      continue
    }

    if (tok.startsWith('-') && tok.length > 1) {
      if (numericShorthandFlag !== null && NUMERIC_SHORT.test(tok)) {
        flags[numericShorthandFlag] = tok.slice(1)
        i += 1
        continue
      }
      let matchedValue = false
      for (const vf of valueFlags) {
        if (tok === vf && i + 1 < filteredArgv.length) {
          setValueFlag(flags, vf, filteredArgv[i + 1] ?? '', repeatFlags)
          wordKinds[origIndices[i + 1] ?? -1] = valueFlagKinds.get(vf) ?? null
          i += 2
          matchedValue = true
          break
        }
        if (tok.startsWith(vf) && tok.length > vf.length) {
          setValueFlag(flags, vf, tok.slice(vf.length), repeatFlags)
          i += 1
          matchedValue = true
          break
        }
      }
      if (matchedValue) continue

      if (boolFlags.has(tok)) {
        flags[tok] = true
        i += 1
        continue
      }

      let allBool = true
      for (const ch of tok.slice(1)) {
        if (!boolFlags.has(`-${ch}`)) {
          allBool = false
          break
        }
      }
      if (allBool && tok.length > 1) {
        for (const ch of tok.slice(1)) flags[`-${ch}`] = true
        i += 1
        continue
      }

      const mixed = matchMixedCluster(tok, boolFlags, valueFlags)
      if (mixed !== null) {
        if (mixed.attached !== null) {
          for (const name of mixed.bools) flags[name] = true
          setValueFlag(flags, mixed.valueFlag, mixed.attached, repeatFlags)
          i += 1
          continue
        }
        if (i + 1 < filteredArgv.length) {
          for (const name of mixed.bools) flags[name] = true
          setValueFlag(flags, mixed.valueFlag, filteredArgv[i + 1] ?? '', repeatFlags)
          wordKinds[origIndices[i + 1] ?? -1] = valueFlagKinds.get(mixed.valueFlag) ?? null
          i += 2
          continue
        }
      }

      if (lenientDashOperands || NUMERIC_SHORT.test(tok)) {
        rawArgs.push(tok)
        rawIndices.push(origIndices[i] ?? -1)
      } else {
        warnings.push(`warning: unknown option '${tok}' ignored`)
      }
      i += 1
      continue
    }

    rawArgs.push(tok)
    rawIndices.push(origIndices[i] ?? -1)
    i += 1
  }

  const positional: OperandKind[] = spec.positional
    .filter((op) => !op.providedBy.some((name) => name in flags))
    .map((op) => op.kind)

  const classified: [string, OperandKind][] = []
  const rawOperands: [string, OperandKind][] = []
  for (let j = 0; j < rawArgs.length; j++) {
    const arg = rawArgs[j]
    if (arg === undefined) continue
    let kind: OperandKind
    if (j < positional.length) {
      kind = positional[j] ?? OperandKind.TEXT
    } else if (restKind !== null) {
      kind = restKind
    } else {
      continue
    }
    if (kind === OperandKind.PATH) {
      classified.push([resolvePath(arg, cwd), OperandKind.PATH])
      rawOperands.push([arg, OperandKind.PATH])
    } else {
      classified.push([arg, OperandKind.TEXT])
      rawOperands.push([arg, OperandKind.TEXT])
    }
    const origIdx = rawIndices[j]
    if (origIdx !== undefined && origIdx >= 0) wordKinds[origIdx] = kind
  }

  const pathFlagValues: string[] = []
  for (const [flagName, kind] of valueFlagKinds) {
    if (kind !== OperandKind.PATH || !(flagName in flags)) continue
    const val = flags[flagName]
    if (Array.isArray(val)) {
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
  for (const [flagName, kind] of valueFlagKinds) {
    if (kind !== OperandKind.TEXT || !(flagName in flags)) continue
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
    wordKinds,
  })
}

export function parseToKwargs(parsed: ParsedArgs): Record<string, string | boolean | string[]> {
  const result: Record<string, string | boolean | string[]> = {}
  for (const [key, value] of Object.entries(parsed.flags)) {
    let clean = key.replace(/^-+/, '').replaceAll('-', '_')
    clean = AMBIGUOUS_NAMES[clean] ?? clean
    result[clean] = value
  }
  return result
}
