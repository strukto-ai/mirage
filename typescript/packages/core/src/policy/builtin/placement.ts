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
import { RouteDeny } from '../../runtime/routing/errors.ts'
import type { RouteContext, RoutePolicy } from '../../runtime/routing/types.ts'
import type { Policy } from '../base.ts'
import type { Deny, Route } from '../types.ts'

/**
 * The workspace's `routePolicy`, answering at `preExecute`. The router
 * compiles the configured callable or script into this built-in, so a
 * route verdict is one more placement answer: a runtime name
 * (`{ runtime: name }`, `RouteResult`) is a Route, `{ deny: reason }`
 * (`DenyResult`) a Deny, null silence. Its payload and its verdict shapes
 * are the route policy's own. A mistake in it (an unknown verdict key, a
 * script that does not parse) throws `RouteError` to the caller rather
 * than failing closed, since a misconfigured route policy is the
 * deployment's to fix and not a refusal to show an agent. Mirrors the
 * Python `PlacementPolicy`.
 */
export class PlacementPolicy implements Policy {
  constructor(
    private readonly route: RoutePolicy,
    private readonly entries: readonly Runtime[],
  ) {}

  async preExecute(ctx: RouteContext): Promise<Deny | Route | null> {
    let name: string | null
    try {
      name = await evaluatePolicy(this.route, ctx, this.entries)
    } catch (err) {
      if (err instanceof RouteDeny) return { kind: 'deny', reason: err.reason }
      throw err
    }
    return name === null ? null : { kind: 'route', runtime: name }
  }
}
