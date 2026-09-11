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

import type { GoogleConfig } from './config.ts'
import {
  CALENDAR_API_BASE,
  DOCS_API_BASE,
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  FORMS_API_BASE,
  GMAIL_API_BASE,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_BUFFER_SECONDS,
  TOKEN_URL,
} from './constants.ts'
import { apiRequest } from '../api/client.ts'
import { TokenManager as OAuthTokenManager } from '../api/oauth.ts'
import { type ByteWindow } from '../../utils/ranges.ts'

export function tokenUrl(config: GoogleConfig): string {
  return config.apiBase !== undefined ? `${config.apiBase}/token` : TOKEN_URL
}

export function driveBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/drive/v3` : DRIVE_API_BASE
}

export function driveUploadBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/upload/drive/v3` : DRIVE_UPLOAD_BASE
}

export function docsBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/v1` : DOCS_API_BASE
}

export function slidesBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/v1` : SLIDES_API_BASE
}

export function sheetsBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/v4` : SHEETS_API_BASE
}

export function gmailBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/gmail/v1` : GMAIL_API_BASE
}

export function calendarBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/calendar/v3` : CALENDAR_API_BASE
}

export function formsBase(tokenManager: TokenManager): string {
  const base = tokenManager.config.apiBase
  return base !== undefined ? `${base}/v1` : FORMS_API_BASE
}

export class GoogleApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'GoogleApiError'
  }
}

export async function refreshAccessToken(config: GoogleConfig): Promise<[string, number]> {
  if (config.clientId === undefined || config.refreshToken === undefined) {
    throw new Error(
      'refreshAccessToken needs clientId and refreshToken; this config authenticates with a ' +
        'pre-minted accessToken',
    )
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  })
  if (config.clientSecret !== undefined && config.clientSecret !== '') {
    body.set('client_secret', config.clientSecret)
  }
  const data = (await apiRequest('POST', tokenUrl(config), {
    errorOf: (r, text) =>
      new GoogleApiError(`Google token refresh → ${String(r.status)} ${text}`, r.status),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })) as { access_token: string; expires_in: number }
  return [data.access_token, data.expires_in]
}

export class TokenManager extends OAuthTokenManager {
  readonly config: GoogleConfig

  constructor(config: GoogleConfig) {
    super(TOKEN_BUFFER_SECONDS)
    this.config = config
  }

  /**
   * A supplied token short-circuits the grant entirely, and is read every
   * call rather than cached: a provider callable is the caller's own cache,
   * and caching its answer here would outlive the refresh it just performed.
   * Mirrors python's `TokenManager.get_token`.
   */
  override async getToken(): Promise<string> {
    const supplied = this.config.accessToken
    if (supplied !== undefined) return typeof supplied === 'function' ? await supplied() : supplied
    return super.getToken()
  }

  protected async refreshPair(): Promise<[string, number]> {
    if (this.config.refreshFn !== undefined) {
      if (this.config.refreshToken === undefined) {
        throw new Error('refreshFn needs a refreshToken to hand to the caller')
      }
      const result = await this.config.refreshFn(this.config.refreshToken)
      return [result.accessToken, result.expiresIn]
    }
    return refreshAccessToken(this.config)
  }
}

export async function googleHeaders(tm: TokenManager): Promise<Record<string, string>> {
  const token = await tm.getToken()
  return { Authorization: `Bearer ${token}` }
}

export async function googleGet(
  tm: TokenManager,
  url: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  return apiRequest('GET', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google GET ${url} → ${String(r.status)} ${text}`, r.status),
    headers: await googleHeaders(tm),
    params,
  })
}

export async function googlePost(tm: TokenManager, url: string, json: unknown): Promise<unknown> {
  return apiRequest('POST', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google POST ${url} → ${String(r.status)} ${text}`, r.status),
    headers: { ...(await googleHeaders(tm)), 'Content-Type': 'application/json' },
    json,
  })
}

export async function googlePatch(
  tm: TokenManager,
  url: string,
  json: unknown,
  params?: Record<string, string>,
): Promise<unknown> {
  return apiRequest('PATCH', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google PATCH ${url} → ${String(r.status)} ${text}`, r.status),
    headers: { ...(await googleHeaders(tm)), 'Content-Type': 'application/json' },
    params,
    json,
  })
}

// Raw byte payloads (upload endpoints).
export async function googleSendBytes(
  tm: TokenManager,
  method: 'POST' | 'PATCH',
  url: string,
  data: Uint8Array,
  contentType: string,
  params?: Record<string, string>,
): Promise<unknown> {
  return apiRequest(method, url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google ${method} ${url} → ${String(r.status)} ${text}`, r.status),
    headers: { ...(await googleHeaders(tm)), 'Content-Type': contentType },
    params,
    body: data as unknown as BodyInit,
  })
}

export async function googleDelete(tm: TokenManager, url: string): Promise<void> {
  await apiRequest('DELETE', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google DELETE ${url} → ${String(r.status)} ${text}`, r.status),
    headers: await googleHeaders(tm),
    read: 'none',
  })
}

export async function googleGetBytes(
  tm: TokenManager,
  url: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  const data = await apiRequest('GET', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google GET ${url} → ${String(r.status)} ${text}`, r.status),
    headers: await googleHeaders(tm),
    read: 'bytes',
    window,
  })
  return data as Uint8Array
}

export async function* googleGetStream(tm: TokenManager, url: string): AsyncIterable<Uint8Array> {
  const headers = await googleHeaders(tm)
  const r = await fetch(url, { headers, redirect: 'follow' })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new GoogleApiError(`Google GET ${url} → ${String(r.status)} ${text}`, r.status)
  }
  if (r.body === null) return
  const reader = r.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield value
  }
}
