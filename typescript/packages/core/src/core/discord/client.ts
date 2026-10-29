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

import { eacces, enoent } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mimeTypeFor } from '../../utils/filetype.ts'
import { NO_RETRY, apiRequest, type RetryPolicy } from '../api/client.ts'
import { DISCORD_API, GONE_STATUS, MAX_RETRIES, REFUSED_STATUSES } from './constants.ts'
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

/**
 * Report a channel Discord will not show as permission denied.
 *
 * A 401 or 403 (Missing Access) is Discord declining to show what the path
 * names, never the channel saying it is empty, so the path answers the way a
 * directory the caller may not open does: ls names it and fails, find reports
 * it and walks on. A 404 is the channel gone since it was listed. Any other
 * failure, a 429 that outlasted its retries among them, propagates.
 */
export async function refusalsDenied<T>(pathSpec: PathSpec, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ApiError && err.status !== null) {
      if (REFUSED_STATUSES.has(err.status)) throw eacces(pathSpec)
      if (err.status === GONE_STATUS) throw enoent(pathSpec)
    }
    throw err
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

export interface DiscordFile {
  name: string
  data: Uint8Array
}

export interface DiscordTransport {
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse>
  postFiles?(
    endpoint: string,
    body: Record<string, unknown>,
    files: readonly DiscordFile[],
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

  /**
   * POST a message with attachments, as Discord takes them: a multipart body
   * whose `payload_json` part is the JSON body and whose `files[n]` parts are
   * the files, each named by an `attachments` entry of the same id.
   */
  async postFiles(
    endpoint: string,
    body: Record<string, unknown>,
    files: readonly DiscordFile[],
  ): Promise<DiscordResponse> {
    const base = this.baseUrl().replace(/\/$/, '')
    const form = new FormData()
    const payload = { ...body, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }
    form.set('payload_json', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
    files.forEach((f, i) => {
      form.set(
        `files[${String(i)}]`,
        new Blob([f.data as BlobPart], { type: mimeTypeFor(f.name) }),
        f.name,
      )
    })
    return apiRequest('POST', base + endpoint, {
      fetchFn: this.fetch,
      timeout: this.timeout,
      headers: await this.authHeaders(),
      body: form,
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
