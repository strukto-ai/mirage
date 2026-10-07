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

import { storedFunctionText } from '../../../../shell/printer.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { BASH_BUILTINS, KEYWORDS } from '../../../lookup/constants.ts'
import { lookup, lookupAll, program } from '../../../lookup/lookup.ts'
import { Consumer } from '../../../lookup/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { BIN_PREFIX } from '../../../../shell/constants.ts'
import { DESCRIPTIONS } from './constants.ts'
import { NameKind } from './types.ts'
import { sessionEntry } from '../../../session/session.ts'

// The kind one layer reports a name as. A function is a function and one
// of bash's own builtins is a builtin; every other layer runs a program,
// whose file is the name's under /usr/bin.
function kindOf(consumer: Consumer, name: string): NameKind {
  if (consumer === Consumer.FUNCTION) return NameKind.FUNCTION
  if (consumer === Consumer.SESSION && BASH_BUILTINS.has(name)) return NameKind.BUILTIN
  return NameKind.FILE
}

/**
 * Classify the name as the layer that would run it, null if none does.
 *
 * A layer that would run a program reports one only where the name has a
 * file (`program`): a word only the external fallback capture takes still
 * runs, but is not found, as bash reports a name its
 * `command_not_found_handle` would take.
 */
export function classify(
  name: string,
  session: SessionState,
  registry: MountRegistry,
): NameKind | null {
  if (sessionEntry(session.aliases, name) !== undefined) return NameKind.ALIAS
  if (KEYWORDS.has(name)) return NameKind.KEYWORD
  const consumer = lookup(name, session, registry)
  if (consumer === Consumer.UNKNOWN) return null
  const kind = kindOf(consumer, name)
  if (kind === NameKind.FILE && program(name, session, registry) === null) return null
  return kind
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
 * layers: a program both a mount and a CLI answer for is one file. A
 * builtin that is a program too ends with that file's line, as bash's
 * `type -a echo` does after its builtin line. A file is reported only
 * where `program` finds one, so a layer the name runs from without a file
 * (the external fallback, a mount command under a shell-only builtin)
 * prints no line.
 */
export function classifyAll(
  name: string,
  session: SessionState,
  registry: MountRegistry,
): NameKind[] {
  // An alias is reported first and whether or not `expand_aliases` is
  // on, as bash does: `type` describes the definition, not whether the
  // parser is currently applying it.
  const kinds: NameKind[] =
    sessionEntry(session.aliases, name) !== undefined ? [NameKind.ALIAS] : []
  if (KEYWORDS.has(name)) kinds.push(NameKind.KEYWORD)
  const hasFile = program(name, session, registry) !== null
  for (const consumer of lookupAll(name, session, registry)) {
    const kind = kindOf(consumer, name)
    if (kind === NameKind.FILE && !hasFile) continue
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  if (!kinds.includes(NameKind.FILE) && hasFile) kinds.push(NameKind.FILE)
  return kinds
}

/**
 * The kinds to report for one name: hide a layer, then take the top.
 *
 * Hiding is a filter over the layer list, never an edit to the session,
 * and it runs before the winner is picked. That order is what keeps the
 * winner honest: `type -f` reports the layer under a shadowing function,
 * where filtering afterwards would report nothing at all.
 */
export function locations(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  allMode: boolean,
  drop: NameKind | null = null,
): NameKind[] {
  let kinds = classifyAll(name, session, registry)
  if (drop !== null) kinds = kinds.filter((kind) => kind !== drop)
  return allMode ? kinds : kinds.slice(0, 1)
}

/** The path of a program's file, where PATH finds it. */
export function programFile(name: string): string {
  return `${BIN_PREFIX}/${name}`
}

/** Render the verbose line `command -V` and `type` print. A function's line
 * is followed by its body as `declare -f` prints it. `session` is needed to
 * read an alias's value and a function's body; every other kind renders from
 * the name alone. */
export function describe(
  name: string,
  kind: NameKind,
  session?: SessionState,
  parser?: ParseScope,
): string {
  if (kind === NameKind.ALIAS && session !== undefined) {
    return `${name} is aliased to \`${sessionEntry(session.aliases, name) ?? ''}'`
  }
  const body = session === undefined ? undefined : sessionEntry(session.functions, name)
  if (kind === NameKind.FUNCTION && body !== undefined)
    return `${name} is a function\n${storedFunctionText(name, body, parser)}`
  if (kind === NameKind.FILE) return `${name} is ${programFile(name)}`
  return `${name} is ${DESCRIPTIONS[kind] ?? ''}`
}
