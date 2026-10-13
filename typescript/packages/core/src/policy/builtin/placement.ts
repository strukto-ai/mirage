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

import { RouteError } from '../../runtime/routing/errors.ts'
import type { RoutePolicy, RouteVerdict } from '../../runtime/routing/types.ts'
import type { Policy } from '../base.ts'
import { compileProgram, parseProgram } from '../profile.ts'
import type { ScriptPolicy } from '../script.ts'
import type { Action, ProfileScript, RouteContext } from '../types.ts'

/**
 * The workspace's `routePolicy`, answering at `preExecute`. The workspace
 * compiles the configured callable or program into this built-in
 * (`Policies.place`), so a route is one more `preExecute` answer. A
 * callable answers a runtime name (a Route) or null (silence). A program,
 * `{script, runtime}`, runs as a profile's policy programs run and prints
 * what a `preExecute` program may answer. A mistake in either (any other
 * answer, a program that fails) throws `RouteError` to the caller rather
 * than failing closed, since a misconfigured route policy is the
 * deployment's to fix and not a refusal to show an agent.
 * Mirrors the Python `PlacementPolicy`.
 *
 * @throws Error - the route is a string (a path is the workspace yaml's),
 * or the program is not `{script, runtime}`, or its script is still a path.
 */
export class PlacementPolicy implements Policy {
  private readonly call: ((ctx: RouteContext) => RouteVerdict | Promise<RouteVerdict>) | null
  private readonly program: ProfileScript | null

  /**
   * @param route the configured callable or program.
   * @param programs the workspace's program runner, which a program runs on.
   */
  constructor(
    route: RoutePolicy,
    private readonly programs: ScriptPolicy,
  ) {
    if (typeof route === 'string') {
      throw new Error(
        'routePolicy must be a function taking the RouteContext or {script, runtime}; ' +
          "a path is the workspace yaml's",
      )
    }
    if (typeof route === 'function') {
      this.call = route
      this.program = null
      return
    }
    this.call = null
    const program = parseProgram(route, 'routePolicy', true)
    try {
      this.program = compileProgram(program, '')
    } catch (err) {
      throw new Error(`routePolicy ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async preExecute(ctx: RouteContext): Promise<Action | null> {
    if (this.program !== null) {
      try {
        return await this.programs.run(this.program, 'preExecute', ctx)
      } catch (err) {
        throw new RouteError(`route_policy ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const verdict: unknown = await this.call?.(ctx)
    if (verdict === null || verdict === undefined) return null
    if (typeof verdict === 'string' && verdict !== '') return { kind: 'route', runtime: verdict }
    throw new RouteError(
      `route policy must answer a runtime name or None, got ${JSON.stringify(verdict)}`,
    )
  }
}
