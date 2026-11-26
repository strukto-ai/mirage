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

import type { Context } from '@deepseek-ai/cordis'
import type { AskHandler } from '@struktoai/mirage-core/policy/decisions'
import type { Decision } from '@struktoai/mirage-core/policy/types'
import { Outcome, Scope } from '@struktoai/mirage-core/policy/types'
import { shellQuote } from '@struktoai/mirage-core/utils/quote'

/**
 * The tool an approval request is attributed to. A mirage ask is raised
 * by the command plane, which is what dsh's bash tool called, so the
 * audit trail names that tool rather than the head word of the line
 * (which the request's own reason already carries).
 */
export const APPROVAL_TOOL_NAME = 'bash'

/**
 * The outcomes dsh's approval channel answers with.
 *
 * Declared here rather than imported: the type lives in
 * `@deepseek-ai/dsh-sandbox`, which this package does not depend on, and
 * dsh itself treats the channel structurally for the same reason (its
 * `EscalationApprover` is "a minimal STRUCTURAL function shape, not the
 * approval service type"). Staying structural is what lets any approver
 * be wired, dsh's own included.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The one question this bridge asks of dsh: `ctx.approval` narrowed to
 * the call it makes. An `ApprovalService` satisfies it structurally,
 * without this package importing the approval or agent packages.
 */
export interface Approver {
  request(req: {
    agent: object | undefined
    toolName: string
    callId: string
    reason: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * dsh's approval channel, or null when the composition has none.
 *
 * Read through `ctx.get`, not as `ctx.approval`. A plain property read
 * of a service this plugin does not `inject` does not answer undefined,
 * it throws (`cannot get property "approval" without inject`), so
 * probing that way would turn every ask in a composition without an
 * approver into a thrown error instead of a pending one. `ctx.get` is
 * cordis's documented read "without the inject requirement", and its
 * default strictness answers only a provider whose fiber is live, so an
 * unloaded approval plugin reads as absent rather than as a stale
 * channel nobody is listening on.
 *
 * Declaring `inject` instead would be wrong in the other direction: it
 * would make an approval channel a load requirement, and a headless
 * composition that legitimately has none would fail to compose at all.
 *
 * Read at ask time rather than captured when the plugin loads, because
 * cordis composes plugins in whatever order the profile lists them and a
 * snapshot taken at load would miss an approver registered after this.
 *
 * @param ctx the cordis context to read.
 * @returns the approver, or null when nothing provides one.
 */
export function approverOf(ctx: Context): Approver | null {
  const held: unknown = ctx.get('approval')
  if (held === null || typeof held !== 'object') return null
  const { request } = held as { request?: unknown }
  return typeof request === 'function' ? (held as Approver) : null
}

/**
 * What the human is shown: the rule's reason, and the line it is about.
 *
 * The reason alone is the operator's sentence ("deletes are reviewed")
 * and names nothing being deleted, so the line is quoted beside it. The
 * words come off the record rather than being re-rendered, so what was
 * approved is what was asked.
 *
 * Each word is rendered as a shell would read it back, because this
 * string is the whole of what the human authorizes and the words are
 * already-expanded values, not source. Joined raw, `rm -- 'quarterly
 * report'` reads as two operands and a newline inside a name forges a
 * line break in the prompt, so the human would be nodding at something
 * other than the run. `shellQuote` is GNU's diagnostic rendering: an
 * ordinary name stays bare, and only a word a shell would read as
 * something else is dressed.
 *
 * @param record the decision record being asked about.
 * @returns the prompt text.
 */
export function approvalReason(record: Decision): string {
  const line = [record.command, ...record.argv].map(shellQuote).join(' ')
  return `${record.reason}: ${line}`
}

/**
 * Bridge mirage's ask to dsh's approval channel: the handler that fills
 * `WorkspaceOptions.onAsk`.
 *
 * Mirage owns every outcome (`policy/decisions.ts`); this only decides
 * which of its branches an approval answer lands on. Every answer from a
 * live channel is one of mirage's two settled verbs, because
 * `request` blocks until the channel answers and so never reports "no
 * answer yet":
 *
 *   * `allowed-once` is dsh's only yes and grants exactly the line that
 *     asked, so it maps to ALLOW at ONCE and never SESSION. Widening one
 *     nod into a standing grant is the one thing the human did not
 *     consent to; a host that wants SESSION answers writes them into the
 *     decisions themselves (`ws.decisions.answer`), the surface built for it.
 *   * `rejected` is an explicit refusal.
 *   * `cancelled` is a refusal too: the human was shown the prompt and
 *     dismissed it, which is an answer rather than the absence of one.
 *     Leaving it pending would re-prompt them, since a retry reuses the
 *     waiting record and would call `request` again.
 *   * `unavailable` is a permission check that could not run, so it
 *     fails closed. Pending here would be fail-open-into-retry.
 *
 * The three refusals match what dsh does with the same vocabulary for
 * its own escalations, where `approveEscalation` throws on a rejection,
 * a cancellation and an unanswerable ask alike.
 *
 * The run's own signal rides along, so a prompt raised for a line whose
 * run is then killed or times out is dismissed with it rather than left
 * on somebody's screen for a command that no longer exists. The decisions
 * stop waiting either way (they bound the wait by the same signal), but
 * only the channel can take its prompt down.
 *
 * With no approver on the context the handler answers null, which is
 * mirage's "nobody has answered yet": the ask stays pending among the
 * decisions. That is deliberate, and it is why the service installs this
 * unconditionally rather than only under a composed approver — the two
 * are the same answer to mirage (`onAsk` unset and a null return both
 * render pending), and installing always is what lets an approver
 * composed after this plugin still be found.
 *
 * Refusing instead would rewrite an operator's `ask` rule as a `deny`,
 * and the embedder may well be answering `ws.decisions.pending()` out
 * of band.
 *
 * @param ctx the cordis context carrying `ctx.approval`.
 * @returns the handler to pass as `onAsk`.
 */
export function askThroughApproval(ctx: Context): AskHandler {
  return async (record: Decision, signal?: AbortSignal): Promise<Decision | null> => {
    const approver = approverOf(ctx)
    if (approver === null) return null
    const outcome = await approver.request({
      agent: undefined,
      toolName: APPROVAL_TOOL_NAME,
      callId: record.id,
      reason: approvalReason(record),
      ...(signal !== undefined ? { signal } : {}),
    })
    const verb = outcome === 'allowed-once' ? Outcome.ALLOW : Outcome.DENY
    return { ...record, outcome: verb, scope: Scope.ONCE }
  }
}
