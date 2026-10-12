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

import type { Runtime } from '../../runtime/base.ts'
import { evaluatePolicy } from '../../runtime/routing/decide.ts'
import { RouteError } from '../../runtime/routing/errors.ts'
import type { RoutePolicy } from '../../runtime/routing/types.ts'
import type { Policy } from '../base.ts'
import type { Action, RouteContext } from '../types.ts'

/**
 * The workspace's `routePolicy`, answering at `preExecute`. The workspace
 * compiles the configured callable or script into this built-in
 * (`Policies.place`), so a route verdict is one more `preExecute` answer:
 * a runtime name is a Route, null silence. A mistake in it (any other
 * answer, a script that does not parse) throws `RouteError` to the caller
 * rather than failing closed, since a misconfigured route policy is the
 * deployment's to fix and not a refusal to show an agent.
 * Mirrors the Python `PlacementPolicy`.
 */
export class PlacementPolicy implements Policy {
  /**
   * @param route the configured callable or script.
   * @param entries the workspace's ordered runtimes as they stand when a
   *   line is placed, which pick a script's evaluator.
   */
  constructor(
    private readonly route: RoutePolicy,
    private readonly entries: () => readonly Runtime[],
  ) {}

  async preExecute(ctx: RouteContext): Promise<Action | null> {
    const verdict: unknown = await evaluatePolicy(this.route, ctx, this.entries())
    if (verdict === null || verdict === undefined) return null
    if (typeof verdict === 'string' && verdict !== '') return { kind: 'route', runtime: verdict }
    throw new RouteError(
      `route policy must answer a runtime name or None, got ${JSON.stringify(verdict)}`,
    )
  }
}
