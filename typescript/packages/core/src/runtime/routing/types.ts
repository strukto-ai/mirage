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

import type { RouteContext } from '../../policy/types.ts'
import type { RuntimeIdentity, ScriptSource } from '../types.ts'

/**
 * A per-runtime willingness script, answering "do I want this line?".
 * In code: a function (sync or async) on the RouteContext returning a
 * truthy verdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * new WorkspaceRuntime({ script: (ctx) => !ctx.line.includes('/secret') })
 *
 * // workspace yaml: guard.py next to the config file
 * // runtimes:
 * //   - name: vfs
 * //     script: guard.py
 * ```
 */
export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | ScriptSource

/**
 * What the route policy answers: a runtime name places the line, null
 * leaves each command to its first capturer. Refusing a line is a
 * policy's (a preExecute Deny), not the router's. Mirrors the python
 * RouteVerdict.
 */
export type RouteVerdict = string | null

/**
 * The route policy, answering "who takes this line?". In code: a
 * function (sync or async) on the RouteContext returning a
 * RouteVerdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * policy: (ctx) => (ctx.commands.some((c) => c.command === 'python3') ? 'monty' : null)
 *
 * // workspace yaml: policy.py next to the config file
 * // route_policy: policy.py
 * ```
 */
export type RoutePolicy =
  | ((ctx: RouteContext) => RouteVerdict | Promise<RouteVerdict>)
  | ScriptSource

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
   * runtime it runs on, or null when its capturers all refused
   * (admission failure, exit 126, never a silent fallback to the
   * workspace).
   */
  bindings: Record<string, R | null>
  /**
   * Where commands no entry captures run: the catch-all workspace runtime,
   * or null when the workspace runtime refused the line or declares
   * captures; unbound commands then exit 126.
   */
  fallback: R | null
}
