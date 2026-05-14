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

export interface SlackResponse {
  ok: boolean
  error?: string
  needed?: string
  provided?: string
  [key: string]: unknown
}

export class SlackApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly slackError: string,
    public readonly needed: string | null = null,
    public readonly provided: string | null = null,
  ) {
    super(formatSlackErrorMessage(endpoint, slackError, needed, provided))
    this.name = 'SlackApiError'
  }
}

function formatSlackErrorMessage(
  endpoint: string,
  slackError: string,
  needed: string | null,
  provided: string | null,
): string {
  const base = `Slack API error (${endpoint}): ${slackError}`
  if (slackError !== 'missing_scope' || needed === null || needed === '') return base
  const providedRepr = provided !== null && provided !== '' ? provided : '(none)'
  return `${base} (needed: ${needed}; provided: ${providedRepr})`
}

export interface SlackTransport {
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse>
}

export abstract class HttpSlackTransport implements SlackTransport {
  // Indirection so tests can inject a fake fetch without subclass plumbing.
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)

  protected abstract baseUrl(): string
  protected abstract authHeaders(): Promise<Record<string, string>> | Record<string, string>

  async call(
    endpoint: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<SlackResponse> {
    const base = this.baseUrl().replace(/\/$/, '')
    const url = new URL(`${base}/${endpoint}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    }
    const auth = await this.authHeaders()
    const init: RequestInit = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...auth },
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await this.fetch(url, init)
    const data = (await res.json()) as SlackResponse
    if (!data.ok) {
      throw new SlackApiError(
        endpoint,
        data.error ?? 'unknown_error',
        data.needed ?? null,
        data.provided ?? null,
      )
    }
    return data
  }
}

export class NodeSlackTransport extends HttpSlackTransport {
  constructor(
    private readonly token: string,
    private readonly searchToken?: string,
  ) {
    super()
  }
  protected baseUrl(): string {
    return 'https://slack.com/api'
  }
  protected authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }
  // searchToken is read by core/slack/search.ts at call time, not here.
  getSearchToken(): string | undefined {
    return this.searchToken
  }
}
