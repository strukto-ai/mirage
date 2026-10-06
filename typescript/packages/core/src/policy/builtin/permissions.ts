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

import { getAdmission, lineRunning, redirectTargetJudged } from '../../context/session_context.ts'
import type { Policy } from '../base.ts'
import { decide } from '../match/decide.ts'
import { opRuling, posixLevel } from '../match/rule.ts'
import { SESSION_SCOPED, type SessionScoped } from '../mixin.ts'
import {
  Outcome,
  type Action,
  type CommandContext,
  type VfsContext,
  type PolicyHook,
  type SessionCommandsQuery,
} from '../types.ts'

/**
 * The profile's `commands` rules, enforced.
 *
 * Seeded by the workspace after `MountRootPolicy` (POSIX messages still
 * win) and before user policies, so a document rule speaks before a
 * coded one when both match. It reads the session's compiled rules
 * through the narrow `SessionCommandsQuery` by the session id the door
 * put in the context, never through ambient state: an explicit fact
 * survives the async hop that drops a store. Verdicts render through
 * the one outcome table (`renderDeny`), so an agent cannot tell a
 * document deny from a coded one.
 *
 * `preCommand` renders one `decide` call, which is where the law lives:
 * the allow list first (a line it does not cover is refused whole,
 * though its head was visible), then the winning rule, refused whole or
 * per operand by whether it names paths, or taken to the approval door
 * when it asks. `preVfs` walks the deny rules that are pure paths, so
 * FUSE, programmatic ops and the warm cache cannot bypass a path the
 * profile protects. A path rule that asks is a question only where no
 * line is running (a file tool, the host's facade), which the door puts
 * to the approval ledger keyed by rule and path; inside a line it
 * refuses, since the line was admitted without it.
 */
export class PermissionsPolicy implements Policy, SessionScoped {
  readonly [SESSION_SCOPED] = true as const
  private readonly sessions: SessionCommandsQuery

  constructor(sessions: SessionCommandsQuery) {
    this.sessions = sessions
  }

  preCommand(ctx: CommandContext): Action | null {
    const decision = decide(ctx, this.sessions.commandsOf(ctx.sessionId ?? ''))
    if (decision.outcome === Outcome.ALLOW) return null
    const rule = decision.rule
    if (rule === null) {
      const program = (
        ctx.program !== undefined && ctx.program.length > 0 ? ctx.program : [ctx.command]
      ).join(' ')
      return { kind: 'deny', reason: `${program} is not allowed` }
    }
    if (decision.outcome === Outcome.ASK) {
      return { kind: 'ask', reason: rule.reason, rule, rules: decision.asks }
    }
    if (decision.matchedPath === null) return { kind: 'deny', reason: rule.reason, rule }
    return {
      kind: 'deny',
      reason: rule.reason,
      scope: 'operand',
      path: decision.matchedPath,
      rule,
    }
  }

  preVfs(ctx: VfsContext): Action | null {
    if (redirectTargetJudged(ctx.path.virtual)) return null
    // The grants belong to the line, not the session: a once grant is
    // spent as the command is admitted, so by the time its own walk
    // reaches this door the session holds nothing and only the bound
    // gate still remembers the nod.
    const gate = getAdmission()
    const ruled = opRuling(this.sessions.commandsOf(ctx.sessionId ?? ''), ctx, gate?.granted ?? [])
    if (ruled === null) return null
    const [rule, asks] = ruled
    if (asks && gate === null && !lineRunning()) return { kind: 'ask', reason: rule.reason, rule }
    return { kind: 'deny', reason: rule.reason, rule }
  }

  /**
   * Whether this session's rules speak at `hook`: always at the command
   * door, and at the op door only through a pure path rule, the one kind
   * an op can meet (`opReach`).
   */
  wantsFor(hook: PolicyHook, sessionId: string): Promise<boolean> {
    if (hook !== 'preVfs') return Promise.resolve(true)
    const rules = this.sessions.commandsOf(sessionId)
    if (rules === null) return Promise.resolve(false)
    return Promise.resolve([...rules.deny, ...rules.ask].some(posixLevel))
  }
}
