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

import { NO_RETRY, apiRequest, type RetryPolicy } from '../api/client.ts'
import { DISCORD_API, MAX_RETRIES } from './constants.ts'
import { ApiError } from '../api/errors.ts'

const RATE_LIMIT_RETRY: RetryPolicy = {
  ...NO_RETRY,
  statuses: new Set([429]),
  maxRetries: MAX_RETRIES - 1,
  delaySource: 'body',
}

export type DiscordMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type DiscordResponse = unknown

export class DiscordApiError extends ApiError {
  declare readonly status: number
  constructor(
    public readonly endpoint: string,
    status: number,
    public readonly discordError: string,
    public readonly payload?: unknown,
  ) {
    super(`Discord API error (${endpoint}): ${discordError}`, status)
    this.name = 'DiscordApiError'
  }
}

function discordError(endpoint: string, response: Response, body: string): DiscordApiError {
  let parsed: unknown = null
  try {
    parsed = body === '' ? null : JSON.parse(body)
  } catch {
    // a non-JSON error body: fall through to the bare status code
  }
  if (response.status === 429) {
    return new DiscordApiError(endpoint, 429, 'rate_limited', parsed ?? {})
  }
  const message =
    (parsed as { message?: string } | null)?.message ?? `http_${String(response.status)}`
  return new DiscordApiError(endpoint, response.status, message, parsed)
}

export interface DiscordTransport {
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse>
}

export abstract class HttpDiscordTransport implements DiscordTransport {
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)

  constructor(protected readonly timeout?: number) {}
  protected abstract baseUrl(): string
  protected abstract authHeaders(): Promise<Record<string, string>> | Record<string, string>

  async call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    const base = this.baseUrl().replace(/\/$/, '')
    const auth = await this.authHeaders()
    const headers: Record<string, string> = { ...auth }
    if (body !== undefined) headers['content-type'] = 'application/json'
    return apiRequest(method, base + endpoint, {
      fetchFn: this.fetch,
      timeout: this.timeout,
      headers,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { json: body } : {}),
      retry: RATE_LIMIT_RETRY,
      errorOf: (response, text) => discordError(endpoint, response, text),
    })
  }
}

export class NodeDiscordTransport extends HttpDiscordTransport {
  constructor(
    private readonly token: string,
    private readonly base?: string,
    timeout?: number,
  ) {
    super(timeout)
  }
  // base exists so the integ fake can stand in for discord.com; every
  // request must go through it, not the module constant.
  protected baseUrl(): string {
    return this.base ?? DISCORD_API
  }
  protected authHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.token}` }
  }
}
