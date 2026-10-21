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

import type { ProfilePolicySpec } from '../../policy/profile.ts'
import type { RouteContext } from '../../policy/types.ts'
import type { RuntimeIdentity } from '../types.ts'

/**
 * What a route policy function answers: a runtime name places the line,
 * null leaves each command to its first capturer. Refusing a line is a
 * policy's (a preExecute Deny), not the router's. Mirrors the python
 * RouteVerdict.
 */
export type RouteVerdict = string | null

/**
 * The route policy, answering "who takes this line?". In code: a
 * function (sync or async) on the RouteContext returning a
 * RouteVerdict. Or a program, `{script, runtime}`, run as a profile's
 * policy programs run: it reads the context as JSON and prints its
 * answer. Mirrors the python RoutePolicy.
 *
 * ```
 * routePolicy: (ctx) => (ctx.commands.some((c) => c.command === 'python3') ? 'monty' : null)
 *
 * // workspace yaml: route.py next to the config file
 * // route_policy: {script: route.py, runtime: monty}
 * ```
 */
export type RoutePolicy =
  | ((ctx: RouteContext) => RouteVerdict | Promise<RouteVerdict>)
  | ProfilePolicySpec

/**
 * The one-line placement decision the dispatcher consults.
 *
 * Both fields hold runtimes: the decision IS "which runtime runs which
 * command". The workspace runtime is a legal value in either; a command
 * placed on it is served by the workspace executor itself.
 */
export interface RouteDecision<R extends RuntimeIdentity> {
  /**
   * Every command some entry captures, resolved for this line: the
   * runtime it runs on, or null when a route to the workspace keeps the
   * line off its only capturer, a `*` line executor (exit 126, never a
   * silent fallback to the workspace).
   */
  bindings: Record<string, R | null>
  /**
   * Where commands no entry captures run: the catch-all workspace runtime,
   * or null when the workspace runtime declares captures; unbound commands
   * then exit 126.
   */
  fallback: R | null
}
