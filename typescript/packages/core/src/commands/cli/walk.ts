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

import { HELP_OPTION } from '../config.ts'
import { compileSpec, type CompiledSpec, expandLong } from '../spec/compile.ts'
import { FLOAT_VALUE, INT_VALUE } from '../spec/constants.ts'
import { renderHelp } from '../spec/help.ts'
import { resolvePath } from '../../utils/path.ts'
import { CommandSpec } from '../spec/types.ts'
import { WalkResult, type CLISpec, type WalkFlagBag } from './types.ts'

import { USAGE_EXIT } from './constants.ts'

const ENC = new TextEncoder()

/** A subcommand's row label: `name (alias, ...)` like argparse. */
function verbDisplay(child: CLISpec): string {
  return child.aliases.length > 0 ? `${child.name} (${child.aliases.join(', ')})` : child.name
}

/** The subcommand a word names, by canonical name or alias. */
export function findChild(node: CLISpec, word: string): CLISpec | null {
  return node.subcommands.find((c) => c.name === word || c.aliases.includes(word)) ?? null
}

/**
 * Descend a tree by verb words, null if a word names no subcommand.
 *
 * Returns the node and its canonical path, so an alias renders under the
 * name it resolves to, the attribution rule `walk` uses. This is
 * introspection only (`man`): no options are parsed and no usage error is
 * produced, so a caller gets the node or nothing.
 */
export function findNode(
  spec: CLISpec,
  verbs: readonly string[],
): { node: CLISpec; path: string[] } | null {
  let node = spec
  const path: string[] = []
  for (const word of verbs) {
    const child = findChild(node, word)
    if (child === null) return null
    node = child
    path.push(child.name)
  }
  return { node, path }
}

/**
 * True when the node parses its own command line instead of mirage.
 *
 * A script root that declares no grammar is the only such node: the
 * embedded program is the parser, so its flags are not mirage's to
 * recognize, and a generated help page would document nothing. Mirage
 * forwards the whole line to it (a pass-through rest operand) and leaves
 * `--help` to the program. A script root that does declare options or
 * operands opts back into the ordinary machinery, which then renders
 * truthful help and refuses undeclared flags.
 */
export function ownsArgv(node: CLISpec): boolean {
  return (
    node.script !== null &&
    node.options.length === 0 &&
    node.positional.length === 0 &&
    node.rest === null
  )
}

/**
 * A group node's help: the ordinary command help plus Commands rows.
 * One renderer serves leaves and groups; the same text serves `--help`
 * (stdout, exit 0) and the bare-group refusal (stdout, exit 1, matching
 * git). `name` is the full display path as typed ('gws gmail'), so a
 * renamed install renders its own spelling.
 */
export function nodeHelp(name: string, node: CLISpec): string {
  const rows: [string, string][] = node.subcommands.map((child) => [
    verbDisplay(child),
    child.description ?? '',
  ])
  // --help is a registered option everywhere (argparse add_help, click
  // add_help_option, withHelpSupport for leaves), so the listing shows it
  // unless the node declares its own or answers the flag itself
  // (ownsArgv), where advertising it would promise a page mirage no
  // longer renders.
  const listed =
    node.options.some((option) => option.long === '--help') || ownsArgv(node)
      ? node
      : // eslint-disable-next-line @typescript-eslint/no-misused-spread -- init wants a plain field bag
        new CommandSpec({ ...node, options: [...node.options, HELP_OPTION] })
  return renderHelp(name, listed, rows)
}

/**
 * Group-level option refusal: message plus the node's usage block. Mirrors
 * git's shape (`unknown option: --zzz` followed by the usage listing, exit
 * 129). One wording for every level; git itself uses two.
 */
function usageError(name: string, node: CLISpec, message: string): WalkResult {
  return new WalkResult({
    output: ENC.encode(`${message}\n\n${nodeHelp(name, node)}`),
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
 * Match a whole short token against declared spellings. Mirrors the flat
 * parser's precedence before cluster splitting: attached values on
 * attach-capable spellings, then value spellings (exact token wants the
 * next word; longer token carries an attached value), then an exact
 * boolean spelling. Multi-char shorts like find's `-name` only match
 * here. Returns null to fall through to the single-char cluster loop,
 * else [tokens consumed, refusal].
 */
function matchShort(
  name: string,
  node: CLISpec,
  cs: CompiledSpec,
  flags: WalkFlagBag,
  token: string,
  nextToken: string | undefined,
): [number, WalkResult | null] | null {
  for (const vf of cs.attachSpellings) {
    if (token.startsWith(vf) && token.length > vf.length) {
      recordValue(flags, cs, vf, token.slice(vf.length))
      return [1, null]
    }
  }
  for (const vf of cs.valueSpellings) {
    if (token === vf) {
      if (nextToken === undefined) {
        return [0, usageError(name, node, `error: option '${vf}' requires a value`)]
      }
      recordValue(flags, cs, vf, nextToken)
      return [2, null]
    }
    if (token.startsWith(vf) && token.length > vf.length) {
      recordValue(flags, cs, vf, token.slice(vf.length))
      return [1, null]
    }
  }
  if (cs.boolSpellings.has(token)) {
    recordBool(flags, cs, token)
    return [1, null]
  }
  return null
}

/**
 * Prefix-expand a long spelling at a group level. The declared tables
 * match first; the injected `--help` joins the candidate pool when the
 * node does not declare its own, because it is a registered option
 * everywhere else (argparse and getopt_long both expand `--hel` to it).
 */
function expandGroupLong(node: CLISpec, cs: CompiledSpec, spelling: string): readonly string[] {
  const candidates = expandLong(cs, spelling)
  if (
    '--help'.startsWith(spelling) &&
    spelling.length > 2 &&
    !candidates.includes('--help') &&
    !node.options.some((option) => option.long === '--help')
  ) {
    return [...candidates, '--help']
  }
  return candidates
}

/**
 * Resolve PATH-typed group values against the working directory.
 *
 * A group option declared `type: 'path'` has to mean what it means on a leaf,
 * or the type is a lie at exactly one level of the tree. The flat parser
 * resolves PATH values right after defaults land, so a `-C` that defaults to
 * `'.'` becomes the session cwd and a relative `-C build` becomes absolute; do
 * the same here rather than handing a leaf a raw relative string it has no cwd
 * to interpret.
 *
 * Resolved to absolute strings, not PathSpec: a group flag never picks a mount
 * (CLI dispatch consults none), so the routing half of the leaf's PATH recovery
 * has nothing to do here.
 */
function resolveGroupPaths(cs: CompiledSpec, flags: WalkFlagBag, cwd: string): void {
  for (const [dest, kind] of cs.kindByDest) {
    if (kind !== 'path' || !(dest in flags)) continue
    const value = flags[dest]
    if (Array.isArray(value)) {
      flags[dest] = value.map((part) => resolvePath(part, cwd))
    } else if (typeof value === 'string') {
      flags[dest] = resolvePath(value, cwd)
    }
  }
}

/**
 * Apply a node's declarative option rules after its scan: defaults land as
 * if typed and PATH values resolve, then choices and required are enforced,
 * the same order the flat parser uses. Returns a rendered refusal or null when
 * satisfied.
 */
function finishNode(
  name: string,
  node: CLISpec,
  cs: CompiledSpec,
  flags: WalkFlagBag,
  cwd: string,
): WalkResult | null {
  for (const [dest, value] of cs.defaults) {
    if (!(dest in flags)) {
      flags[dest] = cs.multipleDests.has(dest) ? [value] : value
    }
  }
  resolveGroupPaths(cs, flags, cwd)
  // Numeric-typed values before choices, argparse's order; wording is
  // git's parse-options refusal (`--depth` on a non-integer), one phrase
  // for int and float alike.
  for (const [dests, pattern] of [
    [cs.intDests, INT_VALUE],
    [cs.floatDests, FLOAT_VALUE],
  ] as const) {
    for (const dest of dests) {
      const value = flags[dest]
      const candidates = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
      for (const part of candidates) {
        if (!pattern.test(part)) {
          return usageError(name, node, `error: option '${dest}' expects a numerical value`)
        }
      }
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
 * every rendering so a renamed install prints its own name, and `cwd` is the
 * working directory PATH-typed group values resolve against, so a group option
 * resolves the way a leaf option does.
 */
export function walk(head: string, spec: CLISpec, argv: readonly string[], cwd = '/'): WalkResult {
  let node = spec
  let path: string[] = []
  const flags: WalkFlagBag = {}
  let i = 0
  for (;;) {
    // A script node terminates the walk exactly like an fn leaf: its
    // remaining argv rides the ordinary spec machinery for validation,
    // then passes to the program verbatim.
    if (node.fn !== null || node.script !== null) {
      return new WalkResult({ leaf: node, path, groupFlags: flags, argv: argv.slice(i) })
    }
    const name = [head, ...path].join(' ')
    const cs = compileSpec(node)
    let descended = false
    let optionsEnded = false
    while (i < argv.length) {
      const token = argv[i]
      if (token === undefined) break
      if (!optionsEnded && token === '--') {
        optionsEnded = true
        i += 1
        continue
      }
      if (!optionsEnded && token.startsWith('--')) {
        const eq = token.indexOf('=')
        let spelling = eq === -1 ? token : token.slice(0, eq)
        const attached = eq === -1 ? null : token.slice(eq + 1)
        // getopt_long: an exact spelling wins; otherwise a unique prefix
        // expands (git status --porcel) and an ambiguous one is refused
        // with every possibility (git wording).
        if (!cs.dest.has(spelling) && spelling !== '--help') {
          const candidates = expandGroupLong(node, cs, spelling)
          if (candidates.length === 1) {
            spelling = candidates[0] ?? spelling
          } else if (candidates.length > 1) {
            const possible = candidates.join(' or ')
            return usageError(
              name,
              node,
              `error: ambiguous option: ${spelling.slice(2)} (could be ${possible})`,
            )
          }
        }
        // Optional-value longs sit in BOTH longBoolSpellings and
        // longOptionalSpellings, so the optional test runs first or
        // --color=auto would be refused as taking no value.
        if (cs.longOptionalSpellings.has(spelling)) {
          if (attached !== null) {
            recordValue(flags, cs, spelling, attached)
          } else {
            recordBool(flags, cs, spelling)
          }
        } else if (cs.longBoolSpellings.has(spelling)) {
          if (attached !== null) {
            return usageError(name, node, `error: option '${spelling}' takes no value`)
          }
          recordBool(flags, cs, spelling)
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
        } else if (spelling === '--help') {
          if (attached !== null) {
            return usageError(name, node, `error: option '${spelling}' takes no value`)
          }
          return new WalkResult({ output: ENC.encode(nodeHelp(name, node)) })
        } else {
          return usageError(name, node, `unknown option: ${spelling}`)
        }
        i += 1
        continue
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') {
        // Declared multi-char shorts (find-style -name) match the whole
        // token before any cluster splitting, longest first, the same
        // precedence the flat parser uses.
        const whole = matchShort(name, node, cs, flags, token, argv[i + 1])
        if (whole !== null) {
          const [consumed, refused] = whole
          if (refused !== null) return refused
          i += consumed
          continue
        }
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
      const refused = finishNode(name, node, cs, flags, cwd)
      if (refused !== null) return refused
      // An alias resolves to its canonical node; the path records the
      // canonical name (argparse prog attribution: errors under `gws co`
      // render as `gws checkout`).
      const child = findChild(node, token)
      if (child === null) {
        return unknownVerb(head, name, token)
      }
      node = child
      path = [...path, child.name]
      i += 1
      descended = true
      break
    }
    if (descended) continue
    const refused = finishNode(name, node, cs, flags, cwd)
    if (refused !== null) return refused
    return new WalkResult({
      output: ENC.encode(nodeHelp(name, node)),
      stream: 'stdout',
      exitCode: 1,
    })
  }
}
