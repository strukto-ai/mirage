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
import type { Result } from './scope.ts'

const TYPE_USAGE = 'type: usage: type [-afptP] name [name ...]\n'
const WHICH_USAGE = 'which: usage: which [-as] name [name ...]\n'

// bash reserved words: reported by `command -v/-V` and `type` as
// keywords even though the parser, not the executor, consumes them.
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
  'time',
  'coproc',
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
 * Duplicate kinds are dropped, since the kinds are coarser than the
 * layers: a shell builtin that a mount also registers is one `builtin`
 * line, not two identical ones.
 */
export function classifyAll(name: string, session: Session, registry: MountRegistry): NameKind[] {
  if (KEYWORDS.has(name)) return [NameKind.KEYWORD]
  const kinds: NameKind[] = []
  for (const consumer of routeAll(name, session, registry)) {
    const kind = KIND_BY_CONSUMER[consumer]
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/** The kinds to report for one name, honoring an `-a` style flag. */
function locations(
  name: string,
  session: Session,
  registry: MountRegistry,
  allMode: boolean,
): NameKind[] {
  if (allMode) return classifyAll(name, session, registry)
  const kind = classify(name, session, registry)
  return kind === null ? [] : [kind]
}

/** Render the verbose line `command -V` and `type` print. */
export function describe(name: string, kind: NameKind): string {
  return `${name} is ${DESCRIPTIONS[kind]}`
}

/**
 * Split `type`'s options from its name operands.
 *
 * Recognizes `-t` (type word only), `-p`/`-P` (path; empty for mirage's
 * pathless runnables), `-a` (every location) and `-f` (skip the function
 * table). Non-permuting like bash. Returns
 * `[mode, allMode, nofunc, rest, bad]` where `bad` is the first invalid
 * option.
 */
function parseTypeFlags(
  args: readonly string[],
): ['t' | 'p' | null, boolean, boolean, string[], string | null] {
  let mode: 't' | 'p' | null = null
  let allMode = false
  let nofunc = false
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (!(tok.startsWith('-') && tok.length > 1)) break
    for (const ch of tok.slice(1)) {
      if (ch === 't') mode = 't'
      else if (ch === 'p' || ch === 'P') mode = 'p'
      else if (ch === 'a') allMode = true
      else if (ch === 'f') nofunc = true
      else return [null, false, false, [], `-${ch}`]
    }
    i += 1
  }
  return [mode, allMode, nofunc, [...args.slice(i)], null]
}

/** `locations` with `type -f`'s function table masked out. */
function maskedLocations(
  name: string,
  session: Session,
  registry: MountRegistry,
  allMode: boolean,
  nofunc: boolean,
): NameKind[] {
  const saved = session.functions[name]
  if (!nofunc || saved === undefined) return locations(name, session, registry, allMode)
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.functions[name]
  try {
    return locations(name, session, registry, allMode)
  } finally {
    session.functions[name] = saved
  }
}

/**
 * Run the `type` builtin (`type [-afptP] name [name ...]`).
 *
 * Resolution matches `command -V`, but the exit rule is `type`'s: 0 only
 * when every name resolves. `-t` prints the classification word,
 * `-p`/`-P` print a path (always empty here), `-a` prints one line per
 * layer holding the name (a shell function shadowing an installed CLI is
 * the case that has two), and a missing name warns on stderr unless a
 * word-only mode (`-t`/`-p`) is active.
 */
export function handleType(
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const [mode, allMode, nofunc, rest, bad] = parseTypeFlags(args)
  const enc = new TextEncoder()
  if (bad !== null) {
    const err = enc.encode(`type: ${bad}: invalid option\n${TYPE_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'type', exitCode: 2, stderr: err }),
    ]
  }
  const outLines: string[] = []
  const errLines: string[] = []
  let allFound = true
  for (const name of rest) {
    const kinds = maskedLocations(name, session, registry, allMode, nofunc)
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
 * Split `which`'s options from its name operands.
 *
 * debianutils `which` takes `-a` (every location) and `-s` (status
 * only). Deliberate divergence: `--` ends the options here, which the C
 * implementation mishandles. Returns `[allMode, silent, rest, bad]`.
 */
function parseWhichFlags(args: readonly string[]): [boolean, boolean, string[], string | null] {
  let allMode = false
  let silent = false
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (!(tok.startsWith('-') && tok.length > 1)) break
    for (const ch of tok.slice(1)) {
      if (ch === 'a') allMode = true
      else if (ch === 's') silent = true
      else return [false, false, [], `-${ch}`]
    }
    i += 1
  }
  return [allMode, silent, [...args.slice(i)], null]
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
 * its name twice; `type -a` is the surface that names the layers.
 */
export function handleWhich(
  args: readonly string[],
  session: Session,
  registry: MountRegistry,
): Result {
  const [allMode, silent, rest, bad] = parseWhichFlags(args)
  const enc = new TextEncoder()
  if (bad !== null) {
    const err = enc.encode(`which: ${bad}: invalid option\n${WHICH_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'which', exitCode: 2, stderr: err }),
    ]
  }
  const outLines: string[] = []
  let allFound = true
  for (const name of rest) {
    const kinds = locations(name, session, registry, allMode).filter(
      (kind) => kind !== NameKind.KEYWORD,
    )
    if (kinds.length === 0) {
      allFound = false
      continue
    }
    if (!silent) outLines.push(...kinds.map(() => name))
  }
  const out = outLines.length > 0 ? enc.encode(`${outLines.join('\n')}\n`) : null
  const code = rest.length > 0 && allFound ? 0 : 1
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'which', exitCode: code }),
  ]
}
