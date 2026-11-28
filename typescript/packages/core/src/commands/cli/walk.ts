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
import { flagOccurrences } from '../spec/flag_view.ts'
import { HELP_OPTION, FLOAT_VALUE, INT_VALUE, NEGATIVE_NUMBER } from '../spec/constants.ts'
import { compileSpec, type CompiledSpec, expandLong } from '../spec/compile.ts'
import { type ParsedArgs, parseCommand } from '../spec/parser.ts'
import {
  argparseHelp,
  clapGroupRefusal,
  clapUnexpectedArgument,
  renderHelp,
  usageLine,
} from '../spec/help.ts'
import { CommandSpec, type CommandSpecInit, UsageStyle, Argument, WordKind } from '../spec/types.ts'
import { PathSpec } from '../../types.ts'

import { COBRA_EXIT, cobraRefusal, groupMessage, unknownCommand } from './cobra.ts'
import { COMMANDER_EXIT, excessArguments, missingValue, unknownOption } from './commander.ts'
import {
  DefaultCommandRoot,
  WalkResult,
  WalkWord,
  type CLI,
  type LeafParse,
  type WalkFlagBag,
} from './types.ts'

import {
  CLAP_EXIT,
  GIT_LONG_OPTIONS,
  GIT_SYNOPSES,
  HELP_EXIT,
  POPPLER_EXIT,
  USAGE_EXIT,
} from './constants.ts'
import { gitOptionRefusal, HELP_SWITCH } from './refusal.ts'
import { encodeText } from '../../shell/bytes.ts'

// A textual rest operand is a CLI node's pass-through form: parsed under
// unknownIsOperand, it takes the undeclared dashed tokens the node does not
// refuse, which is what a program parsing its own argv needs. 'str', not
// 'path', so nothing is cwd-resolved or routed. Only that parse reads the
// rest kind this way: a GNU command's textual rest is a list of operands,
// which is why basename has one and still refuses an option it does not know.
const PASSTHROUGH_REST = new Argument('args', { metavar: '', nargs: '*' })

// Each leaf's parse grammar, kept so every parse of the leaf reuses one
// spec object and hits the parse cache, as compileSpec keeps its tables.
const GRAMMARS = new WeakMap<CommandSpec, Map<string, [CommandSpec, boolean]>>()

/** A subcommand's row label: `name (alias, ...)` like argparse. */
function verbDisplay(child: CommandSpec): string {
  return child.aliases.length > 0 ? `${child.name} (${child.aliases.join(', ')})` : child.name
}

/** The subcommand a word names, by canonical name or alias. */
export function findChild(node: CommandSpec, word: string): CommandSpec | null {
  return node.subcommands.find((c) => c.name === word || c.aliases.includes(word)) ?? null
}

/**
 * Every `Argument.env` variable a program tree reads.
 *
 * The env-plane fill step asks this per installed head word on the
 * line, so a managed name a CLI reads from the environment joins the
 * fetch set even though no `$NAME` appears in the line's text.
 */
export function envNames(node: CommandSpec): ReadonlySet<string> {
  const out = new Set<string>()
  for (const opt of compileSpec(node).options) {
    if (opt.env !== null) out.add(opt.env)
  }
  for (const child of node.subcommands) {
    for (const name of envNames(child)) out.add(name)
  }
  return out
}

/**
 * Env names on the verb paths the line's words could select.
 *
 * The words prune the tree: a subcommand joins only when some word
 * spells its name or an alias, recursively, so a bare head reads the
 * root's env names and `ntn api get` adds exactly the api and get
 * nodes. A word doubling as an operand over-selects, which costs one
 * fetch; a verb can never hide, because dispatch only runs a verb the
 * line spells. Null means a word no static read can spell (an
 * expansion), where the whole tree is the only safe answer.
 */
export function invokedEnvNames(
  spec: CommandSpec,
  words: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (words === null) return envNames(spec)
  const out = new Set<string>()
  for (const opt of compileSpec(spec).options) {
    if (opt.env !== null) out.add(opt.env)
  }
  for (const child of spec.subcommands) {
    if (words.has(child.name) || child.aliases.some((alias) => words.has(alias))) {
      for (const name of invokedEnvNames(child, words)) out.add(name)
    }
  }
  return out
}

/**
 * The spelling one dash token certainly supplies, and its width.
 *
 * Mirrors the exact-token arms the walk and the flat parser share -- an
 * attached value, a value in the next word, a bare boolean -- and
 * answers null for anything subtler (a cluster, an abbreviation, an
 * undeclared spelling, a long given a value it refuses), where the
 * caller must stop claiming anything.
 */
function suppliedOption(
  cs: CompiledSpec,
  token: string,
  following: readonly string[],
): [string, number] | null {
  const next = following[0]
  if (token.startsWith('--')) {
    const eq = token.indexOf('=')
    const spelling = eq === -1 ? token : token.slice(0, eq)
    const width = cs.nargsByDest.get(cs.destOf(spelling))
    if (width === 1 && eq !== -1) return [spelling, 1]
    if (width !== undefined)
      return eq === -1 && following.length >= width ? [spelling, width + 1] : null
    if (cs.longOptionalSpellings.has(spelling)) {
      const detached = cs.detachedOptionalSpellings.has(spelling) && optionalValue(next)
      return [spelling, eq === -1 && detached ? 2 : 1]
    }
    if (cs.longBoolSpellings.has(spelling)) return eq === -1 ? [spelling, 1] : null
    if (cs.longValueSpellings.has(spelling)) {
      if (eq !== -1) return [spelling, 1]
      return next !== undefined ? [spelling, 2] : null
    }
    return null
  }
  for (const vf of cs.attachSpellings) {
    if (token.startsWith(vf) && token.length > vf.length) return [vf, 1]
  }
  for (const vf of cs.valueSpellings) {
    if (token !== vf && !(token.startsWith(vf) && token.length > vf.length)) continue
    const width = cs.nargsByDest.get(cs.destOf(vf))
    if (width !== undefined) {
      const needed = width - (token === vf ? 0 : 1)
      return following.length >= needed ? [vf, needed + 1] : null
    }
    if (token === vf) return next !== undefined ? [vf, 2] : null
    if (token.startsWith(vf) && token.length > vf.length) return [vf, 1]
  }
  if (cs.detachedOptionalSpellings.has(token)) return [token, optionalValue(next) ? 2 : 1]
  if (cs.boolSpellings.has(token)) return [token, 1]
  return null
}

function optionalValue(value: string | undefined): value is string {
  return (
    value !== undefined && (!value.startsWith('-') || value === '-' || NEGATIVE_NUMBER.test(value))
  )
}

/**
 * Variables every visited reader of which was supplied. `carriers` is
 * each visited level's `envByDest` table in walk order; `supplied` the
 * `level:destination` keys the line certainly fills.
 */
function claimed(
  carriers: readonly ReadonlyMap<string, string>[],
  supplied: ReadonlySet<string>,
): Set<string> {
  const won = new Set<string>()
  const blocked = new Set<string>()
  carriers.forEach((table, level) => {
    for (const [dest, variable] of table) {
      if (supplied.has(`${String(level)}:${dest}`)) won.add(variable)
      else blocked.add(variable)
    }
  })
  for (const variable of blocked) won.delete(variable)
  return won
}

/**
 * Env names whose every reader on the walked path is supplied.
 *
 * The parser never reads `Argument.env` for a destination the line
 * already fills (typed outranks environment), so a supplied option's
 * managed variable is not a read and must not fetch: a dead source
 * would otherwise fail a line that never consults it. Tracking is by
 * destination, never by bare name: two options may declare one
 * variable, and a variable shared by a supplied and an unsupplied
 * destination stays a read, because the unsupplied one still falls
 * back to it. Presence is claimed only where consumption is certain,
 * walking level by level the way `walk` does and matching only the
 * exact-token forms. Anything subtler stops the scan -- keeping what
 * was proven for a word that only ends option parsing (an operand
 * under a remainder leaf, a verb that matches nothing; `--` also
 * drops every variable readable below the group, since the walk keeps
 * descending after it), and keeping nothing for a word whose
 * consumption is in doubt (a cluster, an abbreviation, `--help`) --
 * so a wrong guess can only over-fetch, never skip a real read.
 */
export function suppliedEnvNames(spec: CommandSpec, args: readonly string[]): ReadonlySet<string> {
  const supplied = new Set<string>()
  let node = spec
  let cs = compileSpec(node)
  const carriers: ReadonlyMap<string, string>[] = [cs.envByDest]
  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (token === undefined) break
    if (token === '--') {
      const out = claimed(carriers, supplied)
      for (const child of node.subcommands) {
        for (const below of envNames(child)) out.delete(below)
      }
      return out
    }
    if (token.startsWith('-') && token !== '-') {
      if (token === '--help' || token.startsWith('--help=')) return new Set()
      const hit = suppliedOption(cs, token, args.slice(i + 1))
      if (hit === null) return new Set()
      const [spelling, consumed] = hit
      supplied.add(`${String(carriers.length - 1)}:${cs.destOf(spelling)}`)
      i += consumed
      continue
    }
    if (node.subcommands.length === 0) {
      if (cs.remainder) return claimed(carriers, supplied)
      i += 1
      continue
    }
    const child = findChild(node, token)
    if (child === null) return claimed(carriers, supplied)
    node = child
    cs = compileSpec(node)
    carriers.push(cs.envByDest)
    i += 1
  }
  return claimed(carriers, supplied)
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
  spec: CommandSpec,
  verbs: readonly string[],
): { node: CommandSpec; path: string[] } | null {
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
export function ownsArgv(cli: CLI): boolean {
  return cli.script !== null && cli.spec.arguments.length === 0
}

/**
 * The spec a leaf's argv parses against, and who answers `--help`.
 *
 * Usually mirage: a leaf declares its grammar, the parser enforces it,
 * and `--help` is injected the way argparse's add_help does. Two nodes
 * answer for themselves instead. A leaf that declares `--help` asked for
 * the flag, so it is delivered rather than intercepted. And a script root
 * that declares no grammar (ownsArgv) has the whole line forwarded:
 * refusing `--width` on behalf of a program that accepts it would make
 * the tier unusable, since a YAML `clis:` entry cannot declare options at
 * all. Returns the spec to parse with and whether the injected `--help`
 * is mirage's to answer. CLI init accepts instance fields, so each
 * spread is a plain init bag (the withHelpSupport pattern). The grammar is
 * kept per leaf, so each parse of the leaf reuses one spec object.
 */
function parseSpecFor(
  leaf: CommandSpec,
  style: UsageStyle = UsageStyle.ARGPARSE,
  passthrough = false,
): [CommandSpec, boolean] {
  let kept = GRAMMARS.get(leaf)
  if (kept === undefined) {
    kept = new Map()
    GRAMMARS.set(leaf, kept)
  }
  const key = `${style}:${String(passthrough)}`
  const cached = kept.get(key)
  if (cached !== undefined) return cached
  let found: [CommandSpec, boolean]
  if (passthrough) {
    const spec: CommandSpecInit = leaf
    found = [new CommandSpec({ ...spec, arguments: [...leaf.arguments, PASSTHROUGH_REST] }), false]
  } else {
    const grammar =
      style === UsageStyle.COBRA || style === UsageStyle.COMMANDER
        ? new CommandSpec({ ...(leaf as CommandSpecInit), allowAbbrev: false })
        : leaf
    found =
      !grammar.addHelp || grammar.arguments.some((argument) => argument.names.includes('--help'))
        ? [grammar, false]
        : [listedNode(grammar, style), true]
  }
  kept.set(key, found)
  return found
}

/**
 * How the run parses a CLI leaf's words, which a policy's reading of the
 * line parses with too, so both see the same options.
 *
 * The dialect is the root's: under cobra an undeclared dashed word is an
 * error and no long option abbreviates. git resolves an abbreviated long
 * option against the verb's own full table (parse-options), and its
 * revision walkers take whole words only. `root` is the tree's root, whose
 * dialect every level speaks; `passthrough` says a script owns the leaf's
 * raw argv (ownsArgv).
 */
export function leafParse(
  root: CommandSpec,
  leaf: CommandSpec,
  path: readonly string[],
  passthrough = false,
): LeafParse {
  const [spec, mirageHelp] = parseSpecFor(leaf, root.usageStyle, passthrough)
  return {
    spec,
    mirageHelp,
    unknownIsOperand:
      root.usageStyle !== UsageStyle.COBRA && root.usageStyle !== UsageStyle.COMMANDER,
    abbreviations: root.name === 'git' ? (GIT_LONG_OPTIONS.get(path.join(' ')) ?? []) : undefined,
  }
}

/**
 * A walked line's leaf words, parsed as its run parses them (leafParse).
 * `prog` is the head and the verb path.
 */
export function parseLeaf(
  cli: CLI,
  result: WalkResult,
  cwd: string,
  prog: string,
  env: Readonly<Record<string, string>> | null = null,
): ParsedArgs {
  if (result.leaf === null) throw new Error(`${prog}: the walk reached no leaf`)
  const rules = leafParse(cli.spec, result.leaf, result.path, ownsArgv(cli))
  return parseCommand(
    rules.spec,
    [...result.argv],
    cwd,
    prog,
    env ?? undefined,
    rules.unknownIsOperand,
    rules.abbreviations,
  )
}

/**
 * The options a walked line carries at every level, by canonical
 * spelling: typed, or filled from the environment, never a declared
 * default. What a leaf's `writeWhen` is read against, so an abbreviation
 * the parser accepts counts as the option it names.
 */
export function leafOptions(
  cli: CLI,
  result: WalkResult,
  cwd: string,
  env: Readonly<Record<string, string>> | null = null,
): string[] {
  const prog = [cli.spec.name, ...result.path].join(' ')
  const parsed = parseLeaf(cli, result, cwd, prog, env)
  return [...result.present, ...parsed.typedDests, ...parsed.envDests]
}

/**
 * A group node's help: the ordinary command help plus Commands rows.
 * One renderer serves leaves and groups; the same text serves `--help`
 * (stdout, exit 0) and the bare-group refusal (stdout, exit 1, matching
 * git). `name` is the full display path as typed ('gws gmail'), so a
 * renamed install renders its own spelling.
 */
export function nodeHelp(
  name: string,
  node: CommandSpec,
  style: UsageStyle = UsageStyle.ARGPARSE,
): string {
  if (
    style === UsageStyle.ARGPARSE ||
    style === UsageStyle.COBRA ||
    style === UsageStyle.POPPLER ||
    style === UsageStyle.COMMANDER
  )
    return argparseHelp(name, listedNode(node, style), subcommandRows(node))
  return renderHelp(name, listedNode(node, style), subcommandRows(node), style)
}

/** The node's child rows, as the renderer lists them. */
export function subcommandRows(node: CommandSpec): [string, string][] {
  return node.subcommands.map((child) => [verbDisplay(child), child.description ?? ''])
}

// The node as the renderer shows it, with `--help` filled in. --help is a
// registered option everywhere (argparse add_help, click add_help_option,
// withHelpSupport for leaves), so the listing shows it unless the node
// declares its own or answers the flag itself (ownsArgv), where advertising it
// would promise a page mirage no longer renders. A refusal renders the same
// node a help page would, or its usage line would disagree with `--help`'s.
// It is the grammar alone: a rebuilt CommandSpec is validated again, and the
// added `--help` would collide with a child that declares its own.
export function listedNode(
  node: CommandSpec,
  style: UsageStyle = UsageStyle.ARGPARSE,
): CommandSpec {
  if (!node.addHelp || node.arguments.some((argument) => argument.names.includes('--help')))
    return node
  const names =
    (style === UsageStyle.ARGPARSE ||
      style === UsageStyle.COBRA ||
      style === UsageStyle.POPPLER ||
      style === UsageStyle.COMMANDER) &&
    !node.arguments.some((argument) => argument.names.includes('-h'))
      ? ['-h', '--help']
      : ['--help']
  const help = new Argument(names, { action: 'store_true', help: HELP_OPTION.help })
  const spec: CommandSpecInit = node
  return new CommandSpec({ ...spec, arguments: [...node.arguments, help] })
}

/**
 * Commander's answer to operands a group takes none of. Commander reads the
 * rest of the line before it counts them: an option the group does not
 * declare is refused as unknown, `--help` still prints the help, and past
 * `--` every word is an operand.
 */
function commanderExcess(
  name: string,
  node: CommandSpec,
  cs: CompiledSpec,
  words: readonly string[],
  optionsEnded: boolean,
): WalkResult {
  const operands: string[] = []
  let ended = optionsEnded
  let taking = false
  for (const word of words) {
    if (taking) {
      taking = false
      continue
    }
    if (!ended && word === '--') {
      ended = true
      continue
    }
    if (ended || !word.startsWith('-') || word === '-') {
      operands.push(word)
      continue
    }
    const eq = word.indexOf('=')
    const spelling = eq < 0 ? word : word.slice(0, eq)
    if ((spelling === '--help' || spelling === '-h') && node.addHelp && eq < 0) {
      return new WalkResult({ output: encodeText(nodeHelp(name, node, UsageStyle.COMMANDER)) })
    }
    if (eq < 0 && (cs.longBoolSpellings.has(spelling) || cs.boolSpellings.has(spelling))) continue
    if (cs.longValueSpellings.has(spelling)) {
      taking = eq < 0
      continue
    }
    return usageError(name, node, `unknown option: ${word}`, UsageStyle.COMMANDER, word)
  }
  return new WalkResult({
    output: encodeText(excessArguments(operands)),
    stream: 'stderr',
    exitCode: COMMANDER_EXIT,
  })
}

/**
 * Group-level option refusal, in the dialect the CLI declares. git answers an
 * unknown option in parse-options' words and its usage block (on stdout for
 * `-h`), and the bare `git` with its one synopsis; both exit 129. The bare
 * `git -h` prints the help. clap answers
 * with the message, the one usage line and a footer pointing at --help, and
 * exits 2, at every level of the tree; the exit code is the group's just as
 * much as the leaf's, so reading the style here is what keeps `ntn --bogus`
 * and `ntn pages get --bogus` from disagreeing.
 *
 * `token` is the offending token when the refusal is an unrecognized option,
 * which clap and git word their own way; it is absent for the refusals whose
 * wording the dialects share. `missing` is the option typed with no value
 * after it, which commander words as its argument missing.
 */
function usageError(
  name: string,
  node: CommandSpec,
  message: string,
  style: UsageStyle,
  token?: string,
  missing?: string,
): WalkResult {
  if (style === UsageStyle.COBRA) {
    return new WalkResult({
      output: encodeText(cobraRefusal(groupMessage(message, token), name, node)),
      stream: 'stderr',
      exitCode: COBRA_EXIT,
    })
  }
  if (style === UsageStyle.POPPLER) {
    return new WalkResult({
      output: encodeText(nodeHelp(name, node, style)),
      stream: 'stderr',
      exitCode: POPPLER_EXIT,
    })
  }
  if (style === UsageStyle.COMMANDER) {
    const worded = missing === undefined ? null : missingValue(missing, node)
    const text =
      token !== undefined
        ? unknownOption(token, [node])
        : (worded ?? (message.startsWith('error: ') ? `${message}\n` : `error: ${message}\n`))
    return new WalkResult({ output: encodeText(text), stream: 'stderr', exitCode: COMMANDER_EXIT })
  }
  if (style === UsageStyle.CLAP) {
    const first = token === undefined ? message : clapUnexpectedArgument(token)
    return new WalkResult({
      output: encodeText(
        clapGroupRefusal(name, listedNode(node, style), subcommandRows(node), first),
      ),
      stream: 'stderr',
      exitCode: CLAP_EXIT,
    })
  }
  if (style === UsageStyle.GIT && token !== undefined) {
    const space = name.indexOf(' ')
    const path = space === -1 ? '' : name.slice(space + 1)
    // `git -h` is git's own help, as `git --help` is, and exits 0.
    if (path === '' && token === HELP_SWITCH) {
      return new WalkResult({ output: encodeText(nodeHelp(name, node, style)) })
    }
    if (path === '') {
      const synopsis = GIT_SYNOPSES.get('')?.[0] ?? ''
      return new WalkResult({
        output: encodeText(`unknown option: ${token}\nusage: ${synopsis}\n`),
        stream: 'stderr',
        exitCode: USAGE_EXIT,
      })
    }
    const [shown, refused] = gitOptionRefusal(token, path, node)
    return new WalkResult({
      output: encodeText(shown !== '' ? shown : refused),
      stream: shown !== '' ? 'stdout' : 'stderr',
      exitCode: shown !== '' ? HELP_EXIT : USAGE_EXIT,
    })
  }
  return new WalkResult({
    output: encodeText(`${message}\n\n${nodeHelp(name, node, style)}`),
    stream: 'stderr',
    exitCode: USAGE_EXIT,
  })
}

/** git's unknown-command refusal, with the group path in the noun. */
function unknownVerb(
  head: string,
  name: string,
  word: string,
  node: CommandSpec,
  style: UsageStyle,
): WalkResult {
  if (style === UsageStyle.CLAP) {
    let usage = usageLine(name, node, subcommandRows(node), style)
    if (!name.includes(' ')) usage = usage.replace('<COMMAND>', '[COMMAND]')
    return new WalkResult({
      output: encodeText(
        `error: unrecognized subcommand '${word}'\n\n${usage}\n\nFor more information, try '--help'.\n`,
      ),
      stream: 'stderr',
      exitCode: CLAP_EXIT,
    })
  }
  return new WalkResult({
    output: encodeText(`${head}: '${word}' is not a ${name} command. See '${name} --help'.\n`),
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

/**
 * A group option's value as the walk took it: its dest, the value as typed
 * and the argv position it stands in, the option word's own for an attached
 * value. Mirrors Python's `_Taken`.
 */
interface Taken {
  readonly dest: string
  readonly value: string
  readonly slot: number
}

/**
 * Record a value occurrence. Directory changes are resolved in occurrence
 * order by resolveGroupPaths after the node has been scanned.
 */
function recordValue(
  flags: WalkFlagBag,
  cs: CompiledSpec,
  spelling: string,
  value: string,
  taken: Taken[],
  slot: number,
): void {
  const dest = cs.destOf(spelling)
  taken.push({ dest, value, slot })
  if (cs.multipleDests.has(dest)) {
    const prev = flags[dest]
    if (Array.isArray(prev)) {
      flags[dest] = [...prev, value]
    } else {
      flags[dest] = [value]
    }
  } else {
    flags[dest] = value
  }
}

function recordValues(
  flags: WalkFlagBag,
  cs: CompiledSpec,
  spelling: string,
  values: readonly string[],
  taken: Taken[],
  at: readonly number[],
): void {
  const dest = cs.destOf(spelling)
  values.forEach((value, index) => taken.push({ dest, value, slot: at[index] ?? -1 }))
  const previous = flags[dest]
  flags[dest] =
    cs.multipleDests.has(dest) && Array.isArray(previous) ? [...previous, ...values] : [...values]
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
  node: CommandSpec,
  cs: CompiledSpec,
  flags: WalkFlagBag,
  token: string,
  following: readonly string[],
  style: UsageStyle,
  taken: Taken[],
  at: number,
): [number, WalkResult | null] | null {
  const nextToken = following[0]
  for (const vf of cs.attachSpellings) {
    if (token.startsWith(vf) && token.length > vf.length) {
      recordValue(flags, cs, vf, token.slice(vf.length), taken, at)
      return [1, null]
    }
  }
  for (const vf of cs.valueSpellings) {
    if (token !== vf && !(token.startsWith(vf) && token.length > vf.length)) continue
    const arity = cs.nargsByDest.get(cs.destOf(vf))
    const attached = token.slice(vf.length)
    const remaining = (arity ?? 1) - (attached === '' ? 0 : 1)
    if (following.length < remaining)
      return [
        0,
        usageError(name, node, `error: option '${vf}' requires a value`, style, undefined, vf),
      ]
    const values = [...(attached === '' ? [] : [attached]), ...following.slice(0, remaining)]
    const where = [
      ...(attached === '' ? [] : [at]),
      ...Array.from({ length: remaining }, (_, k) => at + 1 + k),
    ]
    if (arity !== undefined) recordValues(flags, cs, vf, values, taken, where)
    else recordValue(flags, cs, vf, values[0] ?? '', taken, where[0] ?? at)
    return [remaining + 1, null]
  }
  if (cs.detachedOptionalSpellings.has(token) && optionalValue(nextToken)) {
    recordValue(flags, cs, token, nextToken, taken, at + 1)
    return [2, null]
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
/**
 * What each word a walk consumed before its leaf is: a verb is a SUBCOMMAND,
 * a value standing as its own word a VALUE (`-x` in `-C -x`), and any other
 * word an option, which names itself as typed when it carries its value
 * (`-Cb`, `--file=x`). Mirrors Python's `_lead_words`.
 */
function leadWords(
  lead: readonly string[],
  verbs: readonly number[],
  taken: readonly Taken[],
  paths: ReadonlyMap<number, PathSpec>,
): WalkWord[] {
  const words = lead.map(() => new WalkWord(WordKind.OPTION))
  for (const at of verbs) words[at] = new WalkWord(WordKind.SUBCOMMAND)
  for (const t of taken) {
    const word = lead[t.slot] ?? ''
    if (word === t.value) {
      words[t.slot] = new WalkWord(WordKind.VALUE, null, paths.get(t.slot) ?? null)
      continue
    }
    const option =
      t.value !== '' && word.endsWith(t.value) ? word.slice(0, word.length - t.value.length) : word
    words[t.slot] = new WalkWord(
      WordKind.OPTION,
      option.endsWith('=') ? option.slice(0, -1) : option,
      paths.get(t.slot) ?? null,
    )
  }
  return words
}

function expandGroupLong(node: CommandSpec, cs: CompiledSpec, spelling: string): readonly string[] {
  const candidates = expandLong(cs, spelling)
  if (
    node.addHelp &&
    '--help'.startsWith(spelling) &&
    spelling.length > 2 &&
    !candidates.includes('--help') &&
    !cs.dest.has('--help')
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
 * Keep the typed spelling and its walk verdict, just as leaf PATH values do.
 * The operand base resolves first; other path options are relative to it.
 * Each typed value's path is also kept by the argv position it stands in.
 */
function resolveGroupPaths(
  cs: CompiledSpec,
  flags: WalkFlagBag,
  cwd: string,
  bases: PathSpec[],
  taken: readonly Taken[],
  paths: Map<number, PathSpec>,
): void {
  let base: string | PathSpec = cwd
  const typed: [string, string, number][] = taken.map((t) => [t.dest, t.value, t.slot])
  if (cs.baseDest !== null) {
    const value = flags[cs.baseDest]
    if (typeof value === 'string') {
      const values: [string, number | null][] = typed
        .filter(([name]) => name === cs.baseDest)
        .map(([, word, slot]) => [word, slot])
      let scope = PathSpec.fromStrPath('.', undefined, cwd)
      for (const [word, slot] of values.length > 0 ? values : [[value, null] as const]) {
        scope = PathSpec.fromStrPath(word || '.', undefined, scope)
        if (slot === null || !paths.has(slot)) bases.push(scope)
        if (slot !== null) paths.set(slot, scope)
      }
      flags[cs.baseDest] = scope
      base = scope
    }
  }
  const resolved = new Map<string, (PathSpec | string)[]>()
  for (const [name, word, slot] of typed) {
    if (name === cs.baseDest || cs.kindByDest.get(name) !== 'path') continue
    const done = resolved.get(name) ?? []
    resolved.set(name, done)
    const kinds = cs.valueTypesByDest.get(name) ?? ['path']
    if (kinds[done.length % kinds.length] !== 'path') {
      done.push(word)
      continue
    }
    const path = paths.get(slot) ?? PathSpec.fromStrPath(word, undefined, base)
    paths.set(slot, path)
    done.push(path)
  }
  for (const [dest, kind] of cs.kindByDest) {
    if (kind !== 'path' || !(dest in flags) || dest === cs.baseDest) continue
    const value = flags[dest]
    const done = resolved.get(dest)
    const last = done?.at(-1)
    if (Array.isArray(value)) {
      const kinds = cs.valueTypesByDest.get(dest) ?? ['path']
      flags[dest] =
        done?.length === value.length
          ? done
          : value.map((part, index) =>
              kinds[index % kinds.length] === 'path' && typeof part === 'string'
                ? PathSpec.fromStrPath(part, undefined, base)
                : part,
            )
    } else if (last !== undefined) flags[dest] = last
    else if (typeof value === 'string') flags[dest] = PathSpec.fromStrPath(value, undefined, base)
  }
}

/**
 * Apply a node's declarative option rules after its scan: the environment
 * lands first, then defaults, then PATH values resolve and choices and
 * required are enforced, the same order the flat parser uses (parser.ts) --
 * an option's declared variable outranks its default, yields to anything
 * the line typed, and gets the same coercion, choices test and required
 * credit a typed value does. Returns a rendered refusal or null when
 * satisfied.
 */
function finishNode(
  name: string,
  node: CommandSpec,
  cs: CompiledSpec,
  flags: WalkFlagBag,
  cwd: string,
  style: UsageStyle,
  bases: PathSpec[],
  taken: readonly Taken[],
  paths: Map<number, PathSpec>,
  present: string[],
  env: Readonly<Record<string, string>> | null,
  deferEnv: boolean,
): WalkResult | null {
  const own = new Set(cs.dest.values())
  for (const dest of Object.keys(flags)) {
    if (own.has(dest) && !present.includes(dest)) present.push(dest)
  }
  for (const [dest, variable] of cs.envByDest) {
    if (dest in flags) continue
    const supplied = env?.[variable]
    if (supplied === undefined || supplied === '') continue
    present.push(dest)
    flags[dest] = cs.multipleDests.has(dest) ? [supplied] : supplied
  }
  for (const [dest, value] of cs.defaults) {
    if (!(dest in flags)) {
      flags[dest] = cs.multipleDests.has(dest) ? [value] : value
    }
  }
  resolveGroupPaths(cs, flags, cwd, bases, taken, paths)
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
        if (typeof part === 'string' && !pattern.test(part)) {
          return usageError(name, node, `error: option '${dest}' expects a numerical value`, style)
        }
      }
    }
  }
  for (const [dest, allowed] of cs.choicesByDest) {
    const value = flags[dest]
    const candidates = Array.isArray(value)
      ? value
      : typeof value === 'string' || value instanceof PathSpec
        ? [value]
        : []
    for (const part of candidates) {
      const choice = part instanceof PathSpec ? part.virtual : part
      if (!allowed.includes(choice)) {
        return usageError(name, node, `error: invalid argument '${choice}' for '${dest}'`, style)
      }
    }
  }
  for (const dest of cs.requiredDests) {
    if (!(dest in flags) && !(deferEnv && cs.envByDest.has(dest))) {
      return usageError(name, node, `error: option '${dest}' is required`, style)
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
 * every rendering so a renamed install prints its own name, `cwd` is the
 * working directory PATH-typed group values resolve against, so a group option
 * resolves the way a leaf option does, and `env` is the session environment,
 * so a group option declaring `Argument.env` fills at its own level exactly as
 * a leaf one does in the flat parser. `deferEnv` lets target selection reach
 * a leaf before fetching managed values; only an absent environment-backed
 * required option is deferred, and execution still performs the full walk.
 */
export function walk(
  head: string,
  spec: CommandSpec,
  argv: readonly string[],
  cwd = '/',
  env: Readonly<Record<string, string>> | null = null,
  deferEnv = false,
): WalkResult {
  let node = spec
  // Read once off the root and never off a node: a program answers in one
  // voice at every level, so a subcommand cannot pick its own.
  const style = spec.usageStyle
  let path: string[] = []
  let positions: number[] = []
  const flags: WalkFlagBag = {}
  const bases: PathSpec[] = []
  const taken: Taken[] = []
  const paths = new Map<number, PathSpec>()
  const present: string[] = []
  let i = 0
  const first = argv[0]
  if (
    spec instanceof DefaultCommandRoot &&
    spec.subcommands[0] !== undefined &&
    first?.startsWith('-') &&
    first !== '-h' &&
    first !== '--help' &&
    !findChild(spec, first)
  ) {
    node = spec.subcommands[0]
    path = [node.name]
  }
  for (;;) {
    // A script node terminates the walk exactly like an fn leaf: its
    // remaining argv rides the ordinary spec machinery for validation,
    // then passes to the program verbatim.
    if (node.subcommands.length === 0) {
      const tape = flagOccurrences(flags)
      tape.length = 0
      for (const t of taken) tape.push([t.dest, t.value])
      return new WalkResult({
        leaf: node,
        path,
        words: leadWords(argv.slice(0, i), positions, taken, paths),
        groupFlags: flags,
        present,
        operandBases: bases,
        argv: argv.slice(i),
      })
    }
    const name = [head, ...path].join(' ')
    const cs = compileSpec(node)
    let descended = false
    let optionsEnded = false
    while (i < argv.length) {
      const token = argv[i]
      if (token === undefined) break
      const alias =
        !optionsEnded && token.startsWith('-') && !cs.dest.has(token) && token !== '--help'
          ? findChild(node, token)
          : null
      if (alias?.aliases.includes(token)) {
        const refused = finishNode(
          name,
          node,
          cs,
          flags,
          cwd,
          style,
          bases,
          taken,
          paths,
          present,
          env,
          deferEnv,
        )
        if (refused !== null) return refused
        node = alias
        path = [...path, alias.name]
        positions = [...positions, i]
        i += 1
        descended = true
        break
      }
      if (
        !optionsEnded &&
        node.addHelp &&
        token === '-h' &&
        (style === UsageStyle.ARGPARSE ||
          style === UsageStyle.CLAP ||
          style === UsageStyle.COBRA ||
          style === UsageStyle.POPPLER ||
          style === UsageStyle.COMMANDER) &&
        !cs.dest.has('-h')
      ) {
        return new WalkResult({
          output: encodeText(nodeHelp(name, node, style)),
        })
      }
      if (!optionsEnded && token === '--') {
        if (style === UsageStyle.GIT && path.length === 0)
          return usageError(name, node, 'unknown option: --', style, token)
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
        if (
          node.allowAbbrev &&
          style !== UsageStyle.COBRA &&
          style !== UsageStyle.COMMANDER &&
          !cs.dest.has(spelling) &&
          spelling !== '--help'
        ) {
          const candidates = expandGroupLong(node, cs, spelling)
          if (candidates.length === 1) {
            spelling = candidates[0] ?? spelling
          } else if (candidates.length > 1) {
            const possible = candidates.join(' or ')
            return usageError(
              name,
              node,
              `error: ambiguous option: ${spelling.slice(2)} (could be ${possible})`,
              style,
            )
          }
        }
        // Optional-value longs sit in BOTH longBoolSpellings and
        // longOptionalSpellings, so the optional test runs first or
        // --color=auto would be refused as taking no value.
        if (cs.longOptionalSpellings.has(spelling)) {
          if (attached !== null) {
            recordValue(flags, cs, spelling, attached, taken, i)
          } else if (cs.detachedOptionalSpellings.has(spelling) && optionalValue(argv[i + 1])) {
            recordValue(flags, cs, spelling, argv[i + 1] ?? '', taken, i + 1)
            i += 1
          } else {
            recordBool(flags, cs, spelling)
          }
        } else if (cs.longBoolSpellings.has(spelling)) {
          if (attached !== null) {
            return usageError(
              name,
              node,
              `error: option '${spelling}' takes no value`,
              style,
              style === UsageStyle.COMMANDER ? token : undefined,
            )
          }
          recordBool(flags, cs, spelling)
        } else if (cs.longValueSpellings.has(spelling)) {
          const next = argv[i + 1]
          const width = cs.nargsByDest.get(cs.destOf(spelling))
          if (width === 1 && attached !== null) {
            recordValues(flags, cs, spelling, [attached], taken, [i])
          } else if (width !== undefined) {
            if (attached !== null)
              return usageError(name, node, `unknown option: ${token}`, style, token)
            if (argv.length - i - 1 < width)
              return usageError(
                name,
                node,
                `error: option '${spelling}' requires a value`,
                style,
                undefined,
                spelling,
              )
            recordValues(
              flags,
              cs,
              spelling,
              argv.slice(i + 1, i + 1 + width),
              taken,
              Array.from({ length: width }, (_, k) => i + 1 + k),
            )
            i += width
          } else if (attached !== null) {
            recordValue(flags, cs, spelling, attached, taken, i)
          } else if (next !== undefined) {
            i += 1
            recordValue(flags, cs, spelling, next, taken, i)
          } else {
            return usageError(
              name,
              node,
              `error: option '${spelling}' requires a value`,
              style,
              undefined,
              spelling,
            )
          }
        } else if (spelling === '--help' && node.addHelp) {
          if (attached !== null) {
            return usageError(
              name,
              node,
              `error: option '${spelling}' takes no value`,
              style,
              style === UsageStyle.COMMANDER ? token : undefined,
            )
          }
          return new WalkResult({
            output: encodeText(nodeHelp(name, node, style)),
          })
        } else {
          return usageError(
            name,
            node,
            `unknown option: ${spelling}`,
            style,
            style === UsageStyle.GIT ? token : spelling,
          )
        }
        i += 1
        continue
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') {
        // Declared multi-char shorts (find-style -name) match the whole
        // token before any cluster splitting, longest first, the same
        // precedence the flat parser uses.
        const whole = matchShort(name, node, cs, flags, token, argv.slice(i + 1), style, taken, i)
        if (whole !== null) {
          const [consumed, refused] = whole
          if (refused !== null) return refused
          i += consumed
          continue
        }
        let error: string | null = null
        let unknown: string | undefined
        let j = 1
        while (j < token.length) {
          const spelling = `-${token.charAt(j)}`
          if (
            cs.detachedOptionalSpellings.has(spelling) ||
            (cs.attachSpellings.includes(spelling) && j + 1 < token.length) ||
            (!cs.boolSpellings.has(spelling) && cs.dest.has(spelling))
          ) {
            const matched = matchShort(
              name,
              node,
              cs,
              flags,
              `-${token.slice(j)}`,
              argv.slice(i + 1),
              style,
              taken,
              i,
            )
            if (matched !== null) {
              const [consumed, refused] = matched
              if (refused !== null) return refused
              i += consumed - 1
              break
            }
            error = `unknown option: ${spelling}`
            unknown = spelling
            break
          } else if (cs.boolSpellings.has(spelling)) {
            recordBool(flags, cs, spelling)
            j += 1
          } else {
            error = `unknown option: ${spelling}`
            unknown = spelling
            break
          }
        }
        if (error !== null) {
          return usageError(name, node, error, style, unknown)
        }
        i += 1
        continue
      }
      const refused = finishNode(
        name,
        node,
        cs,
        flags,
        cwd,
        style,
        bases,
        taken,
        paths,
        present,
        env,
        deferEnv,
      )
      if (refused !== null) return refused
      // An alias resolves to its canonical node; the path records the
      // canonical name (argparse prog attribution: errors under `gws co`
      // render as `gws checkout`).
      const child = token.startsWith('-') ? null : findChild(node, token)
      if (child === null) {
        if (style === UsageStyle.COBRA) {
          return new WalkResult({
            output: encodeText(cobraRefusal(unknownCommand(token, name, node), name, node)),
            stream: 'stderr',
            exitCode: COBRA_EXIT,
          })
        }
        if (style === UsageStyle.COMMANDER) {
          return commanderExcess(name, node, cs, argv.slice(i), optionsEnded)
        }
        return unknownVerb(head, name, token, node, style)
      }
      node = child
      path = [...path, child.name]
      positions = [...positions, i]
      i += 1
      descended = true
      break
    }
    if (descended) continue
    const refused = finishNode(
      name,
      node,
      cs,
      flags,
      cwd,
      style,
      bases,
      taken,
      paths,
      present,
      env,
      deferEnv,
    )
    if (refused !== null) return refused
    const clapGroup = style === UsageStyle.CLAP && path.length > 0
    return new WalkResult({
      output: encodeText(nodeHelp(name, node, style)),
      stream: clapGroup ? 'stderr' : 'stdout',
      exitCode: clapGroup
        ? CLAP_EXIT
        : style === UsageStyle.COBRA || style === UsageStyle.CLAP
          ? 0
          : 1,
    })
  }
}
