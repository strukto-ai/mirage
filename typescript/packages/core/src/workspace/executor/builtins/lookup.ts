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

import { IOResult } from '../../../io/types.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { route, routeAll } from '../../route/route.ts'
import { Consumer } from '../../route/types.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import { lastOf, scanOptions } from './getopt.ts'
import type { Result } from './scope.ts'

const TYPE_USAGE = 'type: usage: type [-afptP] name [name ...]\n'
const WHICH_USAGE = 'which: usage: which [-as] name [name ...]\n'

// bash reserved words that mirage's grammar implements: reported by
// `command -v/-V` and `type` as keywords even though the parser, not the
// executor, consumes them. bash's `time` and `coproc` are left out on
// purpose. mirage implements neither construct, so a line starting with
// one reports `command not found`, and `type` may not contradict what
// dispatch does. Add a word back when its construct lands.
const KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  '{',
  '}',
  '!',
  '[[',
  ']]',
])

/**
 * What a command name resolves to, spelled as `type -t` prints it.
 *
 * bash's `-t` vocabulary is alias/keyword/function/builtin/file. mirage
 * has no aliases and no external binaries, so `file` never applies and
 * every mirage-native runnable name that is not a function would
 * collapse into `builtin`. `cli` is a sixth word rather than a reuse of
 * `file`: reusing it would promise `type -p` a path to print, and there
 * is none.
 */
export const NameKind = Object.freeze({
  KEYWORD: 'keyword',
  FUNCTION: 'function',
  CLI: 'cli',
  BUILTIN: 'builtin',
} as const)

export type NameKind = (typeof NameKind)[keyof typeof NameKind]

// Shell builtins, namespace commands and mount commands are all
// in-process and pathless, so they share bash's runnable-and-in-process
// category. That collapse is deliberate; `cli` is kept apart because an
// installed CLI is the one runnable an agent cannot otherwise discover.
const KIND_BY_CONSUMER: Readonly<Partial<Record<Consumer, NameKind>>> = Object.freeze({
  [Consumer.SESSION]: NameKind.BUILTIN,
  [Consumer.NAMESPACE]: NameKind.BUILTIN,
  [Consumer.FUNCTION]: NameKind.FUNCTION,
  [Consumer.CLI]: NameKind.CLI,
  [Consumer.MOUNT]: NameKind.BUILTIN,
})

const DESCRIPTIONS: Readonly<Record<NameKind, string>> = Object.freeze({
  [NameKind.KEYWORD]: 'a shell keyword',
  [NameKind.FUNCTION]: 'a function',
  [NameKind.CLI]: 'a mirage CLI',
  [NameKind.BUILTIN]: 'a shell builtin',
})

/** Classify the name as the layer that would run it, null if none does. */
export function classify(name: string, session: Session, registry: MountRegistry): NameKind | null {
  if (KEYWORDS.has(name)) return NameKind.KEYWORD
  return KIND_BY_CONSUMER[route(name, session, registry)] ?? null
}

/**
 * Classify every layer holding the name, most-preferred first.
 *
 * A reserved word goes first and does not end the walk: bash prints both
 * lines when a function shares a keyword's name (pinned:
 * `function time { :; }; type -a time` prints the keyword line then the
 * function line). mirage's parser is looser than bash's about reserved
 * words as function names, so the shadow is reachable here for any of
 * them, and hiding it would leave `type -a` claiming a keyword while the
 * line runs the function.
 *
 * Duplicate kinds are dropped, since the kinds are coarser than the
 * layers: a shell builtin that a mount also registers is one `builtin`
 * line, not two identical ones.
 */
export function classifyAll(name: string, session: Session, registry: MountRegistry): NameKind[] {
  const kinds: NameKind[] = KEYWORDS.has(name) ? [NameKind.KEYWORD] : []
  for (const consumer of routeAll(name, session, registry)) {
    const kind = KIND_BY_CONSUMER[consumer]
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/**
 * The kinds to report for one name: hide a layer, then take the top.
 *
 * Hiding is a filter over the layer list, never an edit to the session,
 * and it runs before the winner is picked. That order is what keeps the
 * winner honest: `type -f` reports the layer under a shadowing function,
 * and `which` the layer under a reserved word, where filtering
 * afterwards would report nothing at all.
 */
function locations(
  name: string,
  session: Session,
  registry: MountRegistry,
  allMode: boolean,
  drop: NameKind | null = null,
): NameKind[] {
  let kinds = classifyAll(name, session, registry)
  if (drop !== null) kinds = kinds.filter((kind) => kind !== drop)
  return allMode ? kinds : kinds.slice(0, 1)
}

/** Render the verbose line `command -V` and `type` print. */
export function describe(name: string, kind: NameKind): string {
  return `${name} is ${DESCRIPTIONS[kind]}`
}

/**
 * Run the `type` builtin (`type [-afptP] name [name ...]`).
 *
 * Resolution matches `command -V`, but the exit rule is `type`'s: 0 only
 * when every name resolves. `-t` prints the classification word,
 * `-p`/`-P` print a path (always empty here) and are one mutually
 * exclusive group with `-t`, `-a` prints one line per layer holding the
 * name (a shell function shadowing an installed CLI is the case that has
 * two), `-f` ignores the function table, and a missing name warns on
 * stderr unless a word-only mode (`-t`/`-p`) is active.
 */
export function handleType(
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const scan = scanOptions(args, 'afptP')
  const enc = new TextEncoder()
  if (scan.bad !== null) {
    const err = enc.encode(`type: ${scan.bad}: invalid option\n${TYPE_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'type', exitCode: 2, stderr: err }),
    ]
  }
  const last = lastOf(scan.letters, 'tpP')
  const mode = last === null || last === 't' ? last : 'p'
  const allMode = scan.letters.includes('a')
  const nofunc = scan.letters.includes('f')
  const rest = scan.operands
  const outLines: string[] = []
  const errLines: string[] = []
  const hidden = nofunc ? NameKind.FUNCTION : null
  let allFound = true
  for (const name of rest) {
    const kinds = locations(name, session, registry, allMode, hidden)
    if (kinds.length === 0) {
      allFound = false
      if (mode === null) errLines.push(`type: ${name}: not found`)
      continue
    }
    if (mode === 't') outLines.push(...kinds)
    else if (mode === null) outLines.push(...kinds.map((kind) => describe(name, kind)))
  }
  const out = outLines.length > 0 ? enc.encode(`${outLines.join('\n')}\n`) : null
  const err = errLines.length > 0 ? enc.encode(`${errLines.join('\n')}\n`) : new Uint8Array()
  const code = rest.length === 0 || allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: 'type', exitCode: code, stderr: err }),
  ]
}

/**
 * Run the `which` builtin (`which [-as] name [name ...]`).
 *
 * Pinned against debianutils `which` (debian:stable-slim): a miss prints
 * nothing at all, the exit status is 0 only when every name resolves (1
 * with no operands), and `-s` reports through the status alone. Two
 * deliberate divergences, both forced by mirage having no PATH: the
 * printed word is the name rather than a path (as `command -v` already
 * does), and every runnable resolves, where GNU reports only files
 * (`which cd` misses there, since a builtin is not on the PATH; here
 * everything is in-process, so reporting nothing would make the command
 * useless). Keywords stay unresolvable, as they are not commands
 * anywhere. `-a` prints one line per layer, so a shadowed name prints
 * its name twice; `type -a` is the surface that names the layers. The
 * refusal for an unknown option is bash's shape, not the C tool's
 * `Illegal option`, because this is a builtin and the usage line cannot
 * honestly name `/usr/bin/which`.
 */
export function handleWhich(
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const scan = scanOptions(args, 'as')
  const enc = new TextEncoder()
  if (scan.bad !== null) {
    const err = enc.encode(`which: ${scan.bad}: invalid option\n${WHICH_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'which', exitCode: 2, stderr: err }),
    ]
  }
  const allMode = scan.letters.includes('a')
  const silent = scan.letters.includes('s')
  const rest = scan.operands
  const outLines: string[] = []
  let allFound = true
  for (const name of rest) {
    const kinds = locations(name, session, registry, allMode, NameKind.KEYWORD)
    if (kinds.length === 0) {
      allFound = false
      continue
    }
    if (!silent) outLines.push(...Array.from({ length: kinds.length }, () => name))
  }
  const out = outLines.length > 0 ? enc.encode(`${outLines.join('\n')}\n`) : null
  const code = rest.length > 0 && allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'which', exitCode: code }),
  ]
}
