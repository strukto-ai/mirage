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

import type { ByteSpool } from '../../io/spool.ts'
import type { ApiResponse, RetryPolicy } from '../api/client.ts'
import type { GoogleConfig } from './config.ts'
import {
  CALENDAR_API_BASE,
  DOCS_API_BASE,
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  FORMS_API_BASE,
  GMAIL_API_BASE,
  MAX_BACKOFF,
  MAX_RETRIES,
  RATE_LIMIT_REASONS,
  RETRY_STATUSES,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_BUFFER_SECONDS,
  TOKEN_URL,
  WRITE_RETRY_STATUSES,
} from './constants.ts'
import { apiRequest, apiStream } from '../api/client.ts'
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

/**
 * Whether a retryable status is worth waiting out. Google answers both "slow
 * down" and "you may not" with a 403, and only its error reason tells them
 * apart: the APIs list the reasons in `error.errors`. Every other listed
 * status is transient as it is.
 */
export function transient(status: number, text: string): boolean {
  if (status !== 403) return true
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return false
  }
  const error =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { error?: unknown }).error
      : undefined
  const errors =
    typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as { errors?: unknown }).errors
      : undefined
  if (!Array.isArray(errors)) return false
  return errors.some((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const reason = (item as { reason?: unknown }).reason
    return typeof reason === 'string' && RATE_LIMIT_REASONS.has(reason)
  })
}

// A read, the token exchange and the start of a resumable upload retry every
// transient status and a dropped connection: none of them changes anything a
// second attempt could repeat, since an upload session creates no file until
// its last chunk commits.
export const READ_RETRY: RetryPolicy = {
  statuses: RETRY_STATUSES,
  maxRetries: MAX_RETRIES,
  maxBackoff: MAX_BACKOFF,
  delaySource: 'header',
  retryTransport: true,
  retryable: transient,
}

// Every other write retries only a rate-limit refusal. A 5xx or a dropped
// connection may come after the change landed, and a retried create, append
// or upload chunk would apply it twice.
export const WRITE_RETRY: RetryPolicy = {
  ...READ_RETRY,
  statuses: WRITE_RETRY_STATUSES,
  retryTransport: false,
}

export class GoogleApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'GoogleApiError'
  }
}

export async function refreshAccessToken(
  config: GoogleConfig,
  sleep?: (seconds: number) => Promise<void>,
): Promise<[string, number]> {
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
    retry: READ_RETRY,
    sleep,
  })) as { access_token: string; expires_in: number }
  return [data.access_token, data.expires_in]
}

export class TokenManager extends OAuthTokenManager {
  readonly config: GoogleConfig
  /** The wait between retries of every call made with this manager, in
   * seconds, injectable so a test spends no real time; absent is a real
   * timer. */
  readonly sleep: ((seconds: number) => Promise<void>) | undefined

  constructor(config: GoogleConfig, sleep?: (seconds: number) => Promise<void>) {
    super(TOKEN_BUFFER_SECONDS)
    this.config = config
    this.sleep = sleep
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
    return refreshAccessToken(this.config, this.sleep)
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
    retry: READ_RETRY,
    sleep: tm.sleep,
  })
}

export async function googlePost(tm: TokenManager, url: string, json: unknown): Promise<unknown> {
  return apiRequest('POST', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google POST ${url} → ${String(r.status)} ${text}`, r.status),
    headers: { ...(await googleHeaders(tm)), 'Content-Type': 'application/json' },
    json,
    retry: WRITE_RETRY,
    sleep: tm.sleep,
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
    retry: WRITE_RETRY,
    sleep: tm.sleep,
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
    retry: WRITE_RETRY,
    sleep: tm.sleep,
  })
}

export async function googleDelete(tm: TokenManager, url: string): Promise<void> {
  await apiRequest('DELETE', url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google DELETE ${url} → ${String(r.status)} ${text}`, r.status),
    headers: await googleHeaders(tm),
    read: 'none',
    retry: WRITE_RETRY,
    sleep: tm.sleep,
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
    retry: READ_RETRY,
    sleep: tm.sleep,
  })
  return data as Uint8Array
}

/** GET a URL's raw bytes as they arrive. Mirrors Python's `google_get_stream`. */
export async function* googleGetStream(
  tm: TokenManager,
  url: string,
): AsyncGenerator<Uint8Array, void> {
  yield* apiStream(url, {
    errorOf: (r, text) =>
      new GoogleApiError(`Google GET ${url} → ${String(r.status)} ${text}`, r.status),
    headers: await googleHeaders(tm),
    retry: READ_RETRY,
    sleep: tm.sleep,
  })
}

export async function googleResumable(
  tm: TokenManager,
  method: 'POST' | 'PATCH',
  url: string,
  metadata: Record<string, unknown>,
  spool: ByteSpool,
  mimeType: string,
  params: Record<string, string>,
): Promise<unknown> {
  const errorOf = (r: Response, text: string) =>
    new GoogleApiError(`Google upload → ${String(r.status)} ${text}`, r.status)
  const location = await apiRequest(method, url, {
    errorOf,
    headers: {
      ...(await googleHeaders(tm)),
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(spool.size),
    },
    params: { ...params, uploadType: 'resumable' },
    json: metadata,
    read: 'location',
    retry: READ_RETRY,
    sleep: tm.sleep,
  })
  if (typeof location !== 'string' || location === '')
    throw new Error('Drive upload session returned no Location')
  let offset = 0
  while (offset < spool.size) {
    const data = await spool.read(offset, 8 * 1024 * 1024)
    const response = (await apiRequest('PUT', location, {
      errorOf,
      headers: {
        ...(await googleHeaders(tm)),
        'Content-Type': mimeType,
        'Content-Range': `bytes ${String(offset)}-${String(offset + data.length - 1)}/${String(spool.size)}`,
      },
      body: data as unknown as BodyInit,
      read: 'response',
      retry: WRITE_RETRY,
      sleep: tm.sleep,
    })) as ApiResponse
    if (response.status === 200 || response.status === 201) return response.data
    if (response.status !== 308)
      throw new Error(`Unexpected Drive upload status: ${String(response.status)}`)
    const acknowledged = response.headers.range ?? ''
    const next = acknowledged === '' ? 0 : Number(acknowledged.split('-').at(-1)) + 1
    if (!Number.isSafeInteger(next) || next <= offset || next > offset + data.length)
      throw new Error('Drive upload session made no progress')
    offset = next
  }
  throw new Error('Drive upload session did not commit')
}
