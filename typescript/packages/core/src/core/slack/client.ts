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

import { windowFor } from '../../utils/ranges.ts'
import { apiRequest, apiStream } from '../api/client.ts'

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

// Slack reports failures as ok:false payloads, usually with a 200; a
// non-2xx that still carries one keeps Slack's own wording.
function slackHttpError(endpoint: string, response: Response, text: string): SlackApiError {
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (data !== null && typeof data === 'object') {
    const payload = data as SlackResponse
    return new SlackApiError(
      endpoint,
      payload.error ?? 'unknown_error',
      payload.needed ?? null,
      payload.provided ?? null,
    )
  }
  return new SlackApiError(endpoint, `HTTP ${String(response.status)}`)
}

export interface SlackTransport {
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse>
  downloadFile?(url: string, offset?: number, size?: number | null): Promise<Uint8Array>
  downloadFileStream?(url: string, signal?: AbortSignal): AsyncIterable<Uint8Array>
  // Whether this transport's credentials can reach search.* at all. Slack
  // rejects a bot token there, so a doomed call is worth not making; the
  // python twin is `search_available(config)`. A transport that cannot tell
  // (the browser one holds no token, the proxy does) leaves it unimplemented
  // and callers read that as "try it".
  searchAvailable?(): boolean
}

export abstract class HttpSlackTransport implements SlackTransport {
  // Indirection so tests can inject a fake fetch without subclass plumbing.
  protected readonly fetch: typeof fetch = globalThis.fetch.bind(globalThis)

  protected abstract baseUrl(): string
  protected abstract authHeaders(
    endpoint?: string,
  ): Promise<Record<string, string>> | Record<string, string>

  async call(
    endpoint: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<SlackResponse> {
    const base = this.baseUrl().replace(/\/$/, '')
    const auth = await this.authHeaders(endpoint)
    const raw = await apiRequest(body === undefined ? 'GET' : 'POST', `${base}/${endpoint}`, {
      errorOf: (response, text) => slackHttpError(endpoint, response, text),
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...auth },
      ...(params === undefined ? {} : { params }),
      ...(body === undefined ? {} : { json: body }),
      fetchFn: this.fetch,
    })
    const data = (raw ?? {}) as SlackResponse
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

  // Takes the window rather than a prepared header so the answer can be
  // checked against it: Slack serves files from a CDN, and a server is free
  // to ignore Range and reply 200 with the whole file, which the kit's
  // window handling then trims.
  async downloadFile(url: string, offset = 0, size: number | null = null): Promise<Uint8Array> {
    const auth = await this.authHeaders()
    const window = windowFor(offset, size)
    const data = await apiRequest('GET', url, {
      errorOf: (response) =>
        new Error(`slack: download failed (${String(response.status)}): ${url}`),
      headers: auth,
      read: 'bytes',
      ...(window === undefined ? {} : { window }),
      fetchFn: this.fetch,
    })
    return data as Uint8Array
  }

  async *downloadFileStream(url: string, signal?: AbortSignal): AsyncGenerator<Uint8Array, void> {
    yield* apiStream(url, {
      errorOf: (response) =>
        new Error(`slack: download failed (${String(response.status)}): ${url}`),
      headers: await this.authHeaders(),
      fetchFn: this.fetch,
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

export class NodeSlackTransport extends HttpSlackTransport {
  constructor(
    private readonly token: string,
    private readonly searchToken?: string,
    private readonly baseUrlOverride?: string,
  ) {
    super()
  }
  protected baseUrl(): string {
    return this.baseUrlOverride !== undefined && this.baseUrlOverride !== ''
      ? this.baseUrlOverride
      : 'https://slack.com/api'
  }
  protected authHeaders(endpoint?: string): Record<string, string> {
    const token =
      endpoint?.startsWith('search.') === true &&
      this.searchToken !== undefined &&
      this.searchToken !== ''
        ? this.searchToken
        : this.token
    return { Authorization: `Bearer ${token}` }
  }
  searchAvailable(): boolean {
    if (this.searchToken !== undefined && this.searchToken !== '') return true
    return this.token.startsWith('xoxp-')
  }
}
