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

// Request headers and error messages follow @tavily/core 1.1.0's transport,
// which tvly 1.0.2 sends through (MIT; see licenses/third_party/tavily-cli.txt).

import type { TavilyAccessor } from '../../accessor/tavily.ts'
import { callerSignal } from '../../context/session_context.ts'
import type { JsonValue } from '../../types.ts'
import { apiRequest, apiStream, type ReadMode } from '../api/client.ts'
import { ApiError } from '../api/errors.ts'
import { numberText } from '../render/json.ts'
import { isRecord } from '../../utils/records.ts'
import {
  CLIENT_SOURCE,
  DEFAULT_API_BASE_URL,
  DEFAULT_TIMEOUT,
  KEYLESS_CLIENT_SOURCE,
} from './constants.ts'

/** The longest delay Node's timers hold; one past it fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A call the Tavily API refused. */
export class TavilyAPIError extends ApiError {
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'TavilyAPIError'
  }
}

/** The keyless fair-use cap, with the envelope the API sends for it. */
export class TavilyKeylessLimit extends TavilyAPIError {
  constructor(
    message: string,
    status: number,
    readonly error: Record<string, JsonValue>,
  ) {
    super(message, status)
    this.name = 'TavilyKeylessLimit'
  }
}

/** A call Tavily never answered: it timed out or did not connect. */
export class TavilyUnanswered extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TavilyUnanswered'
  }
}

/** `JSON.stringify(value)`: compact. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value)
}

function errorOf(response: Response, text: string): Error {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  const error = isRecord(body) ? body.error : undefined
  if (isRecord(error) && typeof error.code === 'string' && Array.isArray(error.next_actions)) {
    const message = typeof error.message === 'string' ? error.message : error.code
    return new TavilyKeylessLimit(message, response.status, error as Record<string, JsonValue>)
  }
  const detail = isRecord(body) ? body.detail : undefined
  let message: unknown = isRecord(detail) ? detail.error : undefined
  if ((message === undefined || message === null) && isRecord(error)) message = error.message
  if (typeof message !== 'string' || message === '') {
    message = `${String(response.status)} Error: ${compactJson(body)}`
  }
  return new TavilyAPIError(message as string, response.status)
}

function headers(accessor: TavilyAccessor, clientName: string | undefined): Record<string, string> {
  const key = accessor.config.apiKey
  const out: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Source': key ? CLIENT_SOURCE : KEYLESS_CLIENT_SOURCE,
  }
  if (key) out.Authorization = `Bearer ${key}`
  else out['X-Tavily-Access-Mode'] = 'keyless'
  if (clientName) out['X-Client-Name'] = clientName
  return out
}

/**
 * The body with its `timeout` filled, and how long the call may take. A number
 * the line gave is both the API's budget and the call's; without one the
 * verb's default is both, so the body always says it.
 */
export function timedBody(
  body: Record<string, JsonValue>,
  fallback: number,
): [Record<string, JsonValue>, number] {
  const given = body.timeout
  if (typeof given === 'number') return [body, given]
  return [{ ...body, timeout: fallback }, fallback]
}

/**
 * The failure as tvly prints it: Node's fetch carries the socket error of a
 * connection that never opened (connect ECONNREFUSED, getaddrinfo ENOTFOUND)
 * as its cause; a runtime without one leaves fetch's own error.
 */
function unansweredText(error: TypeError): string {
  return String(error.cause instanceof Error ? error.cause : error)
}

/** One Tavily call; every tvly verb sends through it. */
export async function tavilyRequest(
  accessor: TavilyAccessor,
  method: string,
  endpoint: string,
  body?: JsonValue,
  options: { timeout?: number; clientName?: string | undefined; read?: ReadMode } = {},
): Promise<unknown> {
  const base = (accessor.config.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')
  const budget = options.timeout === undefined ? undefined : Math.trunc(options.timeout * 1000)
  const deadline =
    budget === undefined || budget > MAX_TIMER_MS
      ? undefined
      : AbortSignal.timeout(Math.max(0, budget))
  const stall = accessor.config.timeout ?? DEFAULT_TIMEOUT
  const caller = callerSignal()
  const signal =
    deadline === undefined
      ? caller
      : caller === undefined
        ? deadline
        : AbortSignal.any([caller, deadline])
  try {
    return await apiRequest(method, `${base}/${endpoint}`, {
      errorOf,
      headers: headers(accessor, options.clientName),
      ...(method !== 'GET' && body !== undefined ? { json: body } : {}),
      read: options.read ?? 'json',
      timeout:
        options.timeout !== undefined && Number.isFinite(options.timeout)
          ? Math.max(stall, options.timeout)
          : stall,
      signal,
    })
  } catch (err) {
    throw unanswered(err, deadline?.aborted === true, options.timeout, caller)
  }
}

/** One streamed Tavily POST, its answer chunk by chunk as it arrives. */
export async function* tavilyStream(
  accessor: TavilyAccessor,
  endpoint: string,
  body: JsonValue,
  options: { clientName?: string | undefined } = {},
): AsyncGenerator<Uint8Array, void> {
  const base = (accessor.config.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '')
  const caller = callerSignal()
  try {
    yield* apiStream(`${base}/${endpoint}`, {
      errorOf,
      method: 'POST',
      json: body,
      headers: headers(accessor, options.clientName),
      timeout: accessor.config.timeout ?? DEFAULT_TIMEOUT,
    })
  } catch (err) {
    throw unanswered(err, false, undefined, caller)
  }
}

/**
 * The failure of a call Tavily never answered, in tvly's words; any other
 * failure (the API's refusal, the caller's stop) is handed back as it came.
 */
function unanswered(
  err: unknown,
  timedOut: boolean,
  timeout: number | undefined,
  caller: AbortSignal | undefined,
): unknown {
  if (timedOut || (err instanceof Error && err.name === 'TimeoutError')) {
    const seconds = timeout === undefined ? '0' : numberText(timeout)
    return new TavilyUnanswered(`Request timed out after ${seconds} seconds.`)
  }
  if (err instanceof TypeError && caller?.aborted !== true) {
    return new TavilyUnanswered(
      `An unexpected error occurred while making the request. Error: ${unansweredText(err)}`,
    )
  }
  return err
}
