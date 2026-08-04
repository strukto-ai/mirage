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

import type { MountRegistry } from '../../../mount/registry.ts'
import { KEYWORDS } from '../../../route/constants.ts'
import { route, routeAll } from '../../../route/route.ts'
import type { Session } from '../../../session/session.ts'
import { DESCRIPTIONS, KIND_BY_CONSUMER } from './constants.ts'
import { NameKind } from './types.ts'

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
export function locations(
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
