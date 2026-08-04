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

import type { Policy } from '../../../policy/base.ts'
import { PolicyError } from '../../../policy/errors.ts'
import {
  executeContextPayload,
  type Action,
  type Deny,
  type ExecuteContext,
  type Route,
} from '../../../policy/types.ts'
import type { Runtime } from '../runtime.ts'
import { evalSource, evaluatorOf } from './decide.ts'
import { ScriptSource, type PolicyFn } from './types.ts'

const POLICY_DENY_EXIT = 126

/**
 * Where the routing policy reads the world's current entries. The
 * workspace's Runtimes owner satisfies this structurally; the narrow
 * interface keeps the dependency one-way.
 */
export interface EntriesProvider {
  readonly entries: readonly Runtime[]
}

/**
 * Normalize a routing verdict to an Action or null to pass.
 *
 * Accepts the Action arms themselves (Route/Deny), a bare runtime
 * name, null, and the wire object the arms spell as: `{runtime: name}`
 * places the line, `{deny: reason}` refuses it, keys mutually
 * exclusive. Unknown keys fail loud so a typo never silently passes.
 */
export function parseVerdict(verdict: unknown): Route | Deny | null {
  if (verdict === null) return null
  if (typeof verdict === 'string') return { kind: 'route', runtime: verdict }
  if (verdict instanceof Map) {
    // A custom evaluator may hand python dicts back as Map (the monty
    // engine did before its boundary normalized); fold to the plain
    // object wire shape instead of misreading Map as an empty dict.
    const folded: Record<string, unknown> = {}
    for (const [key, value] of verdict) folded[String(key)] = value
    return parseVerdict(folded)
  }
  if (typeof verdict === 'object' && !Array.isArray(verdict) && !(verdict instanceof Uint8Array)) {
    const obj = verdict as Record<string, unknown>
    if (obj.kind === 'route' || obj.kind === 'deny') return verdict as Route | Deny
    const unknown = Object.keys(obj)
      .filter((key) => key !== 'runtime' && key !== 'deny')
      .sort()
    if (unknown.length > 0) {
      throw new PolicyError(`unknown policy verdict keys: ${JSON.stringify(unknown)}`)
    }
    if ('deny' in obj && 'runtime' in obj) {
      throw new PolicyError('policy verdict cannot both place and deny')
    }
    if ('deny' in obj) {
      return { kind: 'deny', message: String(obj.deny), exitCode: POLICY_DENY_EXIT }
    }
    if (typeof obj.runtime === 'string') return { kind: 'route', runtime: obj.runtime }
    throw new PolicyError("policy verdict dict needs a 'runtime' name or a 'deny' reason")
  }
  throw new PolicyError(
    `policy must return a runtime name, a verdict dict, or null, got ${JSON.stringify(verdict)}`,
  )
}

/**
 * The `policy` routing script as a preExecute policy.
 *
 * The one built-in the runtime world contributes to the Policies
 * chain: it answers "who takes this line?" by running the configured
 * function or config-borne script and translating its verdict into
 * the closed Action vocabulary, so routing rides the same chain as
 * every other decision instead of a parallel system.
 */
export class RoutingPolicy implements Policy {
  private readonly policy: PolicyFn
  private readonly runtimes: EntriesProvider

  constructor(policy: PolicyFn, runtimes: EntriesProvider) {
    this.policy = policy
    this.runtimes = runtimes
  }

  /** Run the routing script; Route places, Deny refuses (126). */
  async preExecute(ctx: ExecuteContext): Promise<Action | null> {
    // An untyped JS policy can return undefined for "pass"; `?? null`
    // folds it into python's None instead of erroring.
    const verdict =
      this.policy instanceof ScriptSource
        ? await evalSource(
            this.policy.source,
            executeContextPayload(ctx),
            evaluatorOf(this.runtimes.entries, this.policy.language),
          )
        : ((await this.policy(ctx)) ?? null)
    return parseVerdict(verdict)
  }
}
