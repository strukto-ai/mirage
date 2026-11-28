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

// Failure rendering adapted from tvly 1.0.2's src/commands/invoke.ts and
// src/ui/keyless.ts (MIT; see licenses/third_party/tavily-cli.txt).

import type { TavilyAccessor } from '../../../../accessor/tavily.ts'
import {
  TavilyAPIError,
  TavilyKeylessLimit,
  TavilyUnanswered,
} from '../../../../core/tavily/client.ts'
import { IOResult, type CommandOutput } from '../../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIVerbFn } from '../../types.ts'
import { Streams } from './output.ts'
import { field, jsTrim, jsonText, sanitizeControl, truthy } from './render.ts'

const ENC = new TextEncoder()
export const LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 432])
export const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403])
export const USAGE_EXIT = 2
export const AUTH_EXIT = 3
export const API_EXIT = 4
// tvly points a keyless user at `tvly login`; a Mirage install takes its key
// from the config outside the shell, so the hint says where it comes from.
export const NO_KEY = "  No api_key is set in this tvly install's config."
export const CAP_LIFT = "  Setting api_key in the tvly install's config removes this cap."

/** A line tvly refuses before calling the API. */
export function usage(message: string): CommandOutput {
  return [null, new IOResult({ stderr: ENC.encode(`${message}\n`), exitCode: USAGE_EXIT })]
}

/** The refusal of a verb that needs a key, on a keyless install. */
export function requireKey(command: string): CommandOutput {
  const streams = new Streams()
  streams.err()
  streams.err(`  > The ${command} command requires a Tavily API key.`)
  streams.err()
  streams.err(NO_KEY)
  streams.err()
  streams.err(
    '  Tip: tvly search and tvly extract work without an API key (subject to a rate-limit cap).',
  )
  streams.err()
  const [, result] = streams.result(AUTH_EXIT)
  return [null, result]
}

/** A retry delay the way a person reads it: `90s` as `1m 30s`. */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s ? `${String(m)}m ${String(s)}s` : `${String(m)}m`
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m ? `${String(h)}h ${String(m)}m` : `${String(h)}h`
  }
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  return h ? `${String(d)}d ${String(h)}h` : `${String(d)}d`
}

/** The `--json` error object for a keyless cap. */
export function keylessCapError(limit: TavilyKeylessLimit): Record<string, JsonValue> {
  const retry = limit.error.retry_after_seconds
  const window = limit.error.window
  return {
    code: limit.error.code ?? null,
    message: limit.message,
    window: typeof window === 'string' ? window : null,
    retry_after_seconds: typeof retry === 'number' ? retry : null,
    next_actions: limit.error.next_actions ?? null,
  }
}

function last(
  actions: readonly Record<string, unknown>[],
  kind: string,
): Record<string, unknown> | undefined {
  return [...actions].reverse().find((action) => action.type === kind)
}

function or(value: unknown, fallback: string): string {
  return truthy(value) ? String(value) : fallback
}

/** `value` when `Number.isInteger` holds for it. */
function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** The cap's envelope as a plain-text block; its first line is the title. */
export function keylessCapText(limit: TavilyKeylessLimit): string {
  const lines = ['Tavily rate limit reached.']
  const message = jsTrim(limit.message)
  if (message) lines.push(message)
  const retry = whole(limit.error.retry_after_seconds)
  if (retry !== null && retry > 0) {
    lines.push('', `Retry after: ${formatSeconds(retry)} (${String(retry)}s)`)
  }
  const raw: unknown = limit.error.next_actions
  const actions = (Array.isArray(raw) ? (raw as unknown[]) : []).filter(
    (action): action is Record<string, unknown> =>
      typeof action === 'object' && action !== null && !Array.isArray(action),
  )
  const signup = last(actions, 'signup')
  const payment = last(actions, 'agentic_payment')
  const bonus = last(actions, 'bonus_credits')
  if (signup || payment || bonus) {
    lines.push('', 'Continuation options:')
    if (signup) {
      lines.push(`  - Sign up for a Tavily API key:  ${or(signup.resource, 'https://tavily.com')}`)
      if (truthy(signup.instruction)) lines.push(`      ${String(signup.instruction)}`)
    }
    if (payment) {
      const label = `  - Pay via ${or(payment.scheme, 'x402')} agentic payment`
      lines.push(truthy(payment.resource) ? `${label}:  ${String(payment.resource)}` : label)
      if (truthy(payment.instruction)) lines.push(`      ${String(payment.instruction)}`)
    }
    if (bonus) {
      const params = field(bonus, 'params')
      const questions = field(params, 'questions')
      const asked = Array.isArray(questions) ? (questions as unknown[]) : []
      if (asked.length > 0) {
        const credits = whole(field(params, 'credits_on_completion'))
        const noun = `${String(asked.length)} question${asked.length !== 1 ? 's' : ''}`
        lines.push(
          credits !== null
            ? `  - Earn ${String(credits)} bonus credits by answering ${noun}:`
            : `  - Earn bonus credits by answering ${noun}:`,
        )
        asked.forEach((question, index) => {
          if (typeof question === 'string') lines.push(`      ${String(index + 1)}. ${question}`)
        })
        lines.push(`    POST your answers to: ${or(bonus.resource, '/v1/keyless/bonus')}`)
      }
    }
  }
  return lines.join('\n')
}

/** Write the cap, its retry delay and how a key lifts it to stderr. */
export function keylessCapHit(streams: Streams, limit: TavilyKeylessLimit): void {
  streams.err()
  sanitizeControl(keylessCapText(limit))
    .split('\n')
    .forEach((line, index) => {
      if (index === 0) streams.err(`  > ${line}`)
      else streams.err(line ? `    ${line}` : '')
    })
  streams.err()
  streams.err(CAP_LIFT)
  streams.err()
}

/** An API failure in tvly's voice: 3 for a limit or a refused key, 4 for anything else. */
export function apiFailure(streams: Streams, error: Error, json: boolean): CommandOutput {
  if (error instanceof TavilyKeylessLimit) {
    if (json) streams.out(jsonText({ error: keylessCapError(error) }, false))
    else keylessCapHit(streams, error)
    return streams.result(AUTH_EXIT)
  }
  const status = error instanceof TavilyAPIError ? error.status : null
  const limit = status !== null && LIMIT_STATUSES.has(status)
  const code = limit || (status !== null && AUTH_STATUSES.has(status)) ? AUTH_EXIT : API_EXIT
  if (json) {
    streams.out(jsonText({ error: error.message }, false))
    return streams.result(code)
  }
  const text = sanitizeControl(error.message)
  if (limit) {
    streams.err()
    streams.err(`  > ${text}`)
    streams.err()
    streams.err('  Upgrade your plan at tavily.com')
    streams.err()
    return streams.result(AUTH_EXIT)
  }
  streams.err(`  > Error: ${text}`)
  return streams.result(code)
}

/** Run one tvly verb, answering an API failure in tvly's voice. */
export function guarded(fn: CLIVerbFn<TavilyAccessor>): CLIVerbFn<TavilyAccessor> {
  return async (
    accessor: TavilyAccessor,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
  ): Promise<CommandFnResult> => {
    try {
      return await fn(accessor, paths, texts, ctx)
    } catch (err) {
      if (!(err instanceof TavilyAPIError) && !(err instanceof TavilyUnanswered)) throw err
      return apiFailure(new Streams(), err, new FlagView(ctx.flags, ctx.spec).asBool('json'))
    }
  }
}
