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

import { compileSpec, type CompiledSpec } from '../spec/compile.ts'
import { renderGroupHelp } from './help.ts'
import { WalkResult, type CLISpec, type WalkFlagBag } from './types.ts'

const ENC = new TextEncoder()

// git prints usage errors at tree levels with exit 129; leaf spec errors
// keep the GNU exit-2 machinery they already ride.
const USAGE_EXIT = 129

/**
 * Group-level option refusal: message plus the node's usage block. Mirrors
 * git's shape (`unknown option: --zzz` followed by the usage listing, exit
 * 129). One wording for every level; git itself uses two.
 */
function usageError(name: string, node: CLISpec, message: string): WalkResult {
  return new WalkResult({
    output: ENC.encode(`${message}\n\n${renderGroupHelp(name, node)}`),
    stream: 'stderr',
    exitCode: USAGE_EXIT,
  })
}

/** git's unknown-command refusal, with the group path in the noun. */
function unknownVerb(head: string, name: string, word: string): WalkResult {
  return new WalkResult({
    output: ENC.encode(`${head}: '${word}' is not a ${name} command. See '${name} --help'.\n`),
    stream: 'stderr',
    exitCode: 1,
  })
}

/** Record a boolean occurrence under its canonical dashed spelling. */
function recordBool(flags: WalkFlagBag, cs: CompiledSpec, spelling: string): void {
  const dest = cs.destOf(spelling)
  if (cs.countDests.has(dest)) {
    const prev = flags[dest]
    flags[dest] = typeof prev === 'number' ? prev + 1 : 1
  } else {
    flags[dest] = true
  }
}

/** Record a value occurrence under its canonical dashed spelling. */
function recordValue(flags: WalkFlagBag, cs: CompiledSpec, spelling: string, value: string): void {
  const dest = cs.destOf(spelling)
  if (cs.multipleDests.has(dest)) {
    const prev = flags[dest]
    if (Array.isArray(prev)) {
      prev.push(value)
    } else {
      flags[dest] = [value]
    }
  } else {
    flags[dest] = value
  }
}

/**
 * Apply a node's declarative option rules after its scan: defaults land as
 * if typed, then choices and required are enforced, the same order the
 * flat parser uses. Returns a rendered refusal or null when satisfied.
 */
function finishNode(
  name: string,
  node: CLISpec,
  cs: CompiledSpec,
  flags: WalkFlagBag,
): WalkResult | null {
  for (const [dest, value] of cs.defaults) {
    if (!(dest in flags)) {
      flags[dest] = cs.multipleDests.has(dest) ? [value] : value
    }
  }
  for (const [dest, allowed] of cs.choicesByDest) {
    const value = flags[dest]
    const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    for (const part of candidates) {
      if (!allowed.includes(part)) {
        return usageError(name, node, `error: invalid argument '${part}' for '${dest}'`)
      }
    }
  }
  for (const dest of cs.requiredDests) {
    if (!(dest in flags)) {
      return usageError(name, node, `error: option '${dest}' is required`)
    }
  }
  return null
}

/**
 * Resolve one command line against a CLI tree.
 *
 * Each level consumes its own options in POSIX order (stop at the first
 * non-option word, which names the subcommand), so `git -C <path> status`
 * shapes parse the way a terminal user expects. Behavior is pinned to git
 * (docker, git 2.47.3): bare group prints its usage to stdout and exits 1,
 * `--help` prints the same to stdout and exits 0, an unknown verb refuses
 * on stderr with exit 1, and group-level option errors refuse on stderr
 * with exit 129. The leaf's own argv is not parsed here; it rides the
 * ordinary spec machinery. `head` is the installed head word, used in
 * every rendering so a renamed install prints its own name.
 */
export function walk(head: string, spec: CLISpec, argv: readonly string[]): WalkResult {
  let node = spec
  let path: string[] = []
  const flags: WalkFlagBag = {}
  let i = 0
  for (;;) {
    if (node.fn !== null) {
      return new WalkResult({ leaf: node, path, groupFlags: flags, argv: argv.slice(i) })
    }
    const name = [head, ...path].join(' ')
    const cs = compileSpec(node)
    let descended = false
    let optionsEnded = false
    while (i < argv.length) {
      const token = argv[i]
      if (token === undefined) break
      if (!optionsEnded && token === '--help') {
        return new WalkResult({ output: ENC.encode(renderGroupHelp(name, node)) })
      }
      if (!optionsEnded && token === '--') {
        optionsEnded = true
        i += 1
        continue
      }
      if (!optionsEnded && token.startsWith('--')) {
        const eq = token.indexOf('=')
        const spelling = eq === -1 ? token : token.slice(0, eq)
        const attached = eq === -1 ? null : token.slice(eq + 1)
        if (cs.longBoolSpellings.has(spelling)) {
          if (attached !== null) {
            return usageError(name, node, `error: option '${spelling}' takes no value`)
          }
          recordBool(flags, cs, spelling)
        } else if (cs.longOptionalSpellings.has(spelling)) {
          if (attached !== null) {
            recordValue(flags, cs, spelling, attached)
          } else {
            recordBool(flags, cs, spelling)
          }
        } else if (cs.longValueSpellings.has(spelling)) {
          const next = argv[i + 1]
          if (attached !== null) {
            recordValue(flags, cs, spelling, attached)
          } else if (next !== undefined) {
            i += 1
            recordValue(flags, cs, spelling, next)
          } else {
            return usageError(name, node, `error: option '${spelling}' requires a value`)
          }
        } else {
          return usageError(name, node, `unknown option: ${spelling}`)
        }
        i += 1
        continue
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') {
        let error: string | null = null
        let j = 1
        while (j < token.length) {
          const spelling = `-${token.charAt(j)}`
          if (cs.boolSpellings.has(spelling)) {
            recordBool(flags, cs, spelling)
            j += 1
          } else if (cs.dest.has(spelling)) {
            const rest = token.slice(j + 1)
            const next = argv[i + 1]
            if (rest !== '') {
              recordValue(flags, cs, spelling, rest)
            } else if (next !== undefined) {
              i += 1
              recordValue(flags, cs, spelling, next)
            } else {
              error = `error: option '${spelling}' requires a value`
            }
            break
          } else {
            error = `unknown option: ${spelling}`
            break
          }
        }
        if (error !== null) {
          return usageError(name, node, error)
        }
        i += 1
        continue
      }
      const refused = finishNode(name, node, cs, flags)
      if (refused !== null) return refused
      const child = node.subcommands.find((c) => c.name === token)
      if (child === undefined) {
        return unknownVerb(head, name, token)
      }
      node = child
      path = [...path, token]
      i += 1
      descended = true
      break
    }
    if (descended) continue
    const refused = finishNode(name, node, cs, flags)
    if (refused !== null) return refused
    return new WalkResult({
      output: ENC.encode(renderGroupHelp(name, node)),
      stream: 'stdout',
      exitCode: 1,
    })
  }
}
