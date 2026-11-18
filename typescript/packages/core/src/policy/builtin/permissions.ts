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

import type { Policy } from '../base.ts'
import { decide } from '../match/decide.ts'
import { Outcome, type Action, type CommandContext, type SessionCommandsQuery } from '../types.ts'

/**
 * The profile's command trees, enforced.
 *
 * Seeded by the workspace after `MountRootPolicy` (POSIX messages still
 * win) and before user policies, so a document rule speaks before a
 * coded one when both match. It reads the session's compiled trees
 * through the narrow `SessionCommandsQuery` by the session id the entry point
 * put in the context, never through ambient state: an explicit fact
 * survives the async hop that drops a store. Verdicts render through
 * the one outcome table (`renderDeny`), so an agent cannot tell a
 * document deny from a coded one.
 *
 * `preCommand` renders one `decide` call, which is where the law lives:
 * the leaf that decided refuses the line, or takes it to the approval
 * ledger when it asks. A tree judges lines only; what every entry point
 * must keep from a path is a hide.
 */
export class PermissionsPolicy implements Policy {
  private readonly sessions: SessionCommandsQuery

  constructor(sessions: SessionCommandsQuery) {
    this.sessions = sessions
  }

  preCommand(ctx: CommandContext): Action | null {
    const decision = decide(ctx, this.sessions.commandsOf(ctx.sessionId ?? ''))
    if (decision.outcome === Outcome.ALLOW) return null
    const rule = decision.rule
    if (rule === null) throw new Error('a tree refused a line with no leaf')
    if (decision.outcome === Outcome.ASK) {
      return { kind: 'ask', reason: rule.reason, rule, rules: decision.asks }
    }
    const path = decision.matchedPath === null ? {} : { path: decision.matchedPath }
    const matched = decision.matched === null ? {} : { matched: decision.matched }
    return { kind: 'deny', reason: rule.reason, ...path, rule, ...matched }
  }
}
