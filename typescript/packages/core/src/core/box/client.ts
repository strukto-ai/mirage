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

import { rstripSlash } from '../../utils/slash.ts'
import { type ByteWindow } from '../../utils/ranges.ts'
import { apiRequest } from '../api/client.ts'
import { TokenManager as OAuthTokenManager } from '../api/oauth.ts'
import { BOX_API_BASE, BOX_TOKEN_URL, BOX_UPLOAD_BASE, TOKEN_BUFFER_SECONDS } from './constants.ts'

export interface BoxConfig {
  // API origin override (e.g. an integ fake: http://127.0.0.1:5096). Token,
  // API and upload URLs derive from it; defaults to the real Box hosts.
  endpoint?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  // Box enterprise ID for the client-credentials grant (server auth apps).
  // With clientId + clientSecret + enterpriseId set, tokens are minted for the
  // app's service account directly; no refresh token is involved and expired
  // tokens are simply re-fetched.
  enterpriseId?: string
  // Pre-fetched access token (e.g. Box developer token from the app console).
  // Lasts ~60 minutes, can't be refreshed programmatically. When set, the
  // TokenManager skips the refresh flow entirely and uses this token directly.
  accessToken?: string
  refreshFn?: (
    refreshToken: string,
  ) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>
  // Box rotates the refresh token on each refresh. Set onRefreshTokenRotated to
  // persist the new token (e.g. write to disk / localStorage / a vault) so that
  // the next process restart starts from the latest token rather than the
  // original one (which is invalid after first use).
  onRefreshTokenRotated?: (newRefreshToken: string) => void | Promise<void>
}

function tokenUrlOf(config: BoxConfig): string {
  return config.endpoint !== undefined && config.endpoint !== ''
    ? `${rstripSlash(config.endpoint)}/oauth2/token`
    : BOX_TOKEN_URL
}

function apiBaseOf(config: BoxConfig): string {
  return config.endpoint !== undefined && config.endpoint !== ''
    ? `${rstripSlash(config.endpoint)}/2.0`
    : BOX_API_BASE
}

function uploadBaseOf(config: BoxConfig): string {
  return config.endpoint !== undefined && config.endpoint !== ''
    ? apiBaseOf(config)
    : BOX_UPLOAD_BASE
}

export class BoxApiError extends Error {
  readonly status: number
  readonly conflict: string | null
  constructor(message: string, status: number, conflict: string | null = null) {
    super(message)
    this.status = status
    this.conflict = conflict
    this.name = 'BoxApiError'
  }
}

/**
 * The type of the item a 409 names as holding the name, or null: Box answers a
 * request onto a taken name with `item_name_in_use` and the item there in
 * `context_info.conflicts` (`file`, `folder`, `web_link`; measured
 * 2026-10-08). A body that is not a JSON object, such as a proxy's HTML page,
 * names none. Mirrors Python's `conflict_of`.
 */
export function conflictOf(text: string): string | null {
  if (!text.trimStart().startsWith('{')) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (err) {
    console.debug(`Box error body is not JSON: ${String(err)}`)
    return null
  }
  const info = (body as { context_info?: { conflicts?: unknown } } | null)?.context_info
  const conflicts: unknown = info?.conflicts
  const first: unknown = Array.isArray(conflicts) ? conflicts[0] : conflicts
  const kind = (first as { type?: unknown } | null | undefined)?.type
  return typeof kind === 'string' ? kind : null
}

/** The error a Box call answers with. Mirrors Python's `_error_of`. */
function errorOf(label: string, url: string): (r: Response, text: string) => BoxApiError {
  return (r, text) =>
    new BoxApiError(`Box ${label} ${url} → ${String(r.status)} ${text}`, r.status, conflictOf(text))
}

async function refreshAccessToken(
  config: BoxConfig,
  currentRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  if (config.clientId === undefined || config.clientId === '') {
    throw new BoxApiError('refreshAccessToken: clientId is required', 400)
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: config.clientId,
  })
  if (config.clientSecret !== undefined && config.clientSecret !== '') {
    body.set('client_secret', config.clientSecret)
  }
  const data = (await apiRequest('POST', tokenUrlOf(config), {
    errorOf: (r, text) =>
      new BoxApiError(`Box token refresh → ${String(r.status)} ${text}`, r.status),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  }
}

async function fetchCcgToken(
  config: BoxConfig,
): Promise<{ accessToken: string; expiresIn: number }> {
  if (config.clientId === undefined || config.clientId === '') {
    throw new BoxApiError('fetchCcgToken: clientId is required', 400)
  }
  if (config.clientSecret === undefined || config.clientSecret === '') {
    throw new BoxApiError('fetchCcgToken: clientSecret is required', 400)
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    box_subject_type: 'enterprise',
    box_subject_id: config.enterpriseId ?? '',
  })
  const data = (await apiRequest('POST', tokenUrlOf(config), {
    errorOf: (r, text) => new BoxApiError(`Box CCG token → ${String(r.status)} ${text}`, r.status),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })) as { access_token: string; expires_in: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

export class BoxTokenManager extends OAuthTokenManager {
  readonly apiBase: string
  readonly uploadBase: string
  private readonly config: BoxConfig
  private readonly devTokenMode: boolean
  private readonly ccgMode: boolean
  private currentRefreshToken: string

  constructor(config: BoxConfig) {
    super(TOKEN_BUFFER_SECONDS)
    this.config = config
    // API and upload bases for every non-token call; api.ts reads these instead
    // of the constants so a config endpoint override reaches every request.
    this.apiBase = apiBaseOf(config)
    this.uploadBase = uploadBaseOf(config)
    this.devTokenMode = config.accessToken !== undefined && config.accessToken !== ''
    this.ccgMode =
      !this.devTokenMode && config.enterpriseId !== undefined && config.enterpriseId !== ''
    if (this.ccgMode) {
      if (config.clientId === undefined || config.clientId === '') {
        throw new Error('BoxTokenManager: clientId is required when using enterpriseId')
      }
      if (config.clientSecret === undefined || config.clientSecret === '') {
        throw new Error('BoxTokenManager: clientSecret is required when using enterpriseId')
      }
    } else if (!this.devTokenMode) {
      if (config.refreshToken === undefined || config.refreshToken === '') {
        throw new Error(
          'BoxTokenManager: provide accessToken (developer token), clientId + clientSecret + enterpriseId (client credentials), or clientId + refreshToken (OAuth)',
        )
      }
      if (config.clientId === undefined || config.clientId === '') {
        throw new Error('BoxTokenManager: clientId is required when using refreshToken')
      }
    }
    this.currentRefreshToken = config.refreshToken ?? ''
    if (this.devTokenMode && config.accessToken !== undefined) {
      // Mark as never-expires from our side; Box itself will 401 after ~1h and
      // the user has to update the env var manually.
      this.seed(config.accessToken, Number.POSITIVE_INFINITY)
    }
  }

  /**
   * Returns the latest refresh token. Box rotates the refresh token on each
   * refresh, so the token passed to the constructor may be stale after the
   * first refresh. Persist this value if you want to survive restarts without
   * re-authenticating. Returns empty string in developer-token and
   * client-credentials modes.
   */
  getRefreshToken(): string {
    return this.currentRefreshToken
  }

  protected async refreshPair(): Promise<[string, number]> {
    if (this.devTokenMode) {
      // Unreachable while the seeded expiry is +Infinity, but keep the
      // branch honest: a dev token can't be refreshed.
      throw new BoxApiError(
        'Box developer token expired (~1 hour lifetime). Regenerate it in the app console and update BOX_ACCESS_TOKEN.',
        401,
      )
    }
    if (this.ccgMode) {
      const ccg = await fetchCcgToken(this.config)
      return [ccg.accessToken, ccg.expiresIn]
    }
    let result: { accessToken: string; refreshToken: string; expiresIn: number }
    if (this.config.refreshFn !== undefined) {
      result = await this.config.refreshFn(this.currentRefreshToken)
    } else {
      result = await refreshAccessToken(this.config, this.currentRefreshToken)
    }
    if (result.refreshToken !== this.currentRefreshToken) {
      this.currentRefreshToken = result.refreshToken
      if (this.config.onRefreshTokenRotated !== undefined) {
        await this.config.onRefreshTokenRotated(result.refreshToken)
      }
    }
    return [result.accessToken, result.expiresIn]
  }
}

async function boxAuthHeaders(tm: BoxTokenManager): Promise<Record<string, string>> {
  const token = await tm.getToken()
  return { Authorization: `Bearer ${token}` }
}

function buildUrl(url: string, params?: Record<string, string | number>): string {
  if (params === undefined) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  return u.toString()
}

export async function boxGet(
  tm: BoxTokenManager,
  url: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  return apiRequest('GET', url, {
    errorOf: errorOf('GET', url),
    headers: await boxAuthHeaders(tm),
    params,
  })
}

export async function boxOptions(tm: BoxTokenManager, url: string): Promise<unknown> {
  return apiRequest('OPTIONS', url, {
    errorOf: errorOf('OPTIONS', url),
    headers: await boxAuthHeaders(tm),
  })
}

export async function boxGetBytes(
  tm: BoxTokenManager,
  url: string,
  params?: Record<string, string | number>,
  window?: ByteWindow,
): Promise<Uint8Array> {
  const data = await apiRequest('GET', url, {
    errorOf: errorOf('GET', url),
    headers: await boxAuthHeaders(tm),
    params,
    read: 'bytes',
    window,
  })
  return data as Uint8Array
}

export async function* boxGetStream(
  tm: BoxTokenManager,
  url: string,
  params?: Record<string, string | number>,
): AsyncIterable<Uint8Array> {
  const headers = await boxAuthHeaders(tm)
  const r = await fetch(buildUrl(url, params), { headers, redirect: 'follow' })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new BoxApiError(`Box GET ${url} → ${String(r.status)} ${text}`, r.status)
  }
  if (r.body === null) return
  const reader = r.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield value
  }
}

export async function boxPostJson(
  tm: BoxTokenManager,
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return apiRequest('POST', url, {
    errorOf: errorOf('POST', url),
    headers: { ...(await boxAuthHeaders(tm)), 'Content-Type': 'application/json' },
    json: body,
  })
}

export async function boxPutJson(
  tm: BoxTokenManager,
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return apiRequest('PUT', url, {
    errorOf: errorOf('PUT', url),
    headers: { ...(await boxAuthHeaders(tm)), 'Content-Type': 'application/json' },
    json: body,
  })
}

export async function boxDelete(
  tm: BoxTokenManager,
  url: string,
  params?: Record<string, string | number>,
  headers: Record<string, string> = {},
): Promise<void> {
  await apiRequest('DELETE', url, {
    errorOf: errorOf('DELETE', url),
    headers: { ...(await boxAuthHeaders(tm)), ...headers },
    params,
    read: 'none',
  })
}

export async function boxUploadMultipart(
  tm: BoxTokenManager,
  url: string,
  attributes: Record<string, unknown>,
  filename: string,
  data: Uint8Array,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const form = new FormData()
  form.set('attributes', JSON.stringify(attributes))
  form.set('file', new Blob([data as BlobPart]), filename)
  return apiRequest('POST', url, {
    errorOf: errorOf('upload', url),
    headers: { ...(await boxAuthHeaders(tm)), ...headers },
    body: form,
  })
}
