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

import type { Policy } from './base.ts'
import { matchOp, matchRule } from './match/rule.ts'
import type { Action, CommandContext, CommandRule, OpsContext } from './types.ts'
import type { HiddenPaths } from '../types.ts'
import { classifyPaths } from '../utils/hidden.ts'

/**
 * A CommandRule compiled to a policy.
 *
 * Internal: the permissions policy evaluates the document's rules
 * through the same matcher this wraps, and nothing outside the package
 * constructs one; it survives as the one-rule form for tests and for
 * code that wants a single rule as a Policy. The rule's paths compile
 * through the same classifier as `paths.hide` and match through the
 * same matcher, so a deny scope and a hide read one grammar.
 */
export class RulePolicy implements Policy {
  readonly rule: CommandRule
  private readonly scope: HiddenPaths | null

  constructor(rule: CommandRule) {
    this.rule = rule
    this.scope = classifyPaths(rule.paths ?? [])
  }

  preCommand(ctx: CommandContext): Action | null {
    const hit = matchRule(this.rule, this.scope, ctx)
    if (hit === null) return null
    if (hit.operand === null) return { kind: 'deny', reason: this.rule.reason }
    return { kind: 'deny', reason: this.rule.reason, scope: 'operand', path: hit.operand }
  }

  preOps(ctx: OpsContext): Action | null {
    // The op-layer twin: pure path protection (no command scope) also
    // holds at the op door, so FUSE, programmatic ops, and the warm
    // cache cannot bypass it. Command-scoped rules stay command-layer:
    // an op does not know which command issued it.
    if (matchOp(this.rule, this.scope, ctx)) return { kind: 'deny', reason: this.rule.reason }
    return null
  }
}
