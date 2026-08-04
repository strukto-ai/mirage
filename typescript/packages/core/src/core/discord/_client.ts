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

export const DISCORD_API = 'https://discord.com/api/v10'
const MAX_RETRIES = 3

export type DiscordMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type DiscordResponse = unknown

export class DiscordApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly discordError: string,
    public readonly payload?: unknown,
  ) {
    super(`Discord API error (${endpoint}): ${discordError}`)
    this.name = 'DiscordApiError'
  }
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
  protected abstract baseUrl(): string
  protected abstract authHeaders(): Promise<Record<string, string>> | Record<string, string>

  async call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    const base = this.baseUrl().replace(/\/$/, '')
    const url = new URL(base + endpoint)
    if (params !== undefined) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    }
    const auth = await this.authHeaders()
    const headers: Record<string, string> = { ...auth }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let last429Payload: unknown = undefined
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const init: RequestInit = { method, headers }
      if (body !== undefined) init.body = JSON.stringify(body)
      const resp = await this.fetch(url.toString(), init)

      if (resp.status === 429) {
        const data = (await resp.json().catch(() => ({}))) as { retry_after?: number }
        last429Payload = data
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (data.retry_after ?? 1) * 1000))
          continue
        }
        break
      }

      if (resp.status === 204) return null
      const text = await resp.text()
      const parsed: unknown = text === '' ? null : JSON.parse(text)
      if (!resp.ok) {
        const err =
          (parsed as { message?: string } | null)?.message ?? `http_${String(resp.status)}`
        throw new DiscordApiError(endpoint, resp.status, err, parsed)
      }
      return parsed
    }
    throw new DiscordApiError(endpoint, 429, 'rate_limited', last429Payload)
  }
}

export class NodeDiscordTransport extends HttpDiscordTransport {
  constructor(
    private readonly token: string,
    private readonly base?: string,
  ) {
    super()
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
