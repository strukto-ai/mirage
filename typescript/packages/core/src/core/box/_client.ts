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

export const BOX_TOKEN_URL = 'https://api.box.com/oauth2/token'
export const BOX_API_BASE = 'https://api.box.com/2.0'
const TOKEN_BUFFER_SECONDS = 300

export interface BoxConfig {
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

export class BoxApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'BoxApiError'
  }
}

export async function refreshAccessToken(
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
  const r = await fetch(BOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new BoxApiError(`Box token refresh → ${String(r.status)} ${text}`, r.status)
  }
  const data = (await r.json()) as {
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
  const r = await fetch(BOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new BoxApiError(`Box CCG token → ${String(r.status)} ${text}`, r.status)
  }
  const data = (await r.json()) as { access_token: string; expires_in: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in }
}

export class BoxTokenManager {
  private readonly config: BoxConfig
  private readonly devTokenMode: boolean
  private readonly ccgMode: boolean
  private currentRefreshToken: string
  private accessToken: string | null = null
  private expiresAt = 0
  private inflight: Promise<string> | null = null

  constructor(config: BoxConfig) {
    this.config = config
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
      this.accessToken = config.accessToken
      // Mark as never-expires from our side; Box itself will 401 after ~1h and
      // the user has to update the env var manually.
      this.expiresAt = Number.POSITIVE_INFINITY
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

  async getToken(): Promise<string> {
    if (this.accessToken !== null && Date.now() / 1000 < this.expiresAt) {
      return this.accessToken
    }
    if (this.devTokenMode) {
      // Should be unreachable since expiresAt is +Infinity in dev-token mode,
      // but keep the branch honest: a dev token can't be refreshed.
      throw new BoxApiError(
        'Box developer token expired (~1 hour lifetime). Regenerate it in the app console and update BOX_ACCESS_TOKEN.',
        401,
      )
    }
    if (this.inflight !== null) return this.inflight
    const p = this.refresh()
    this.inflight = p
    try {
      return await p
    } finally {
      this.inflight = null
    }
  }

  private async refresh(): Promise<string> {
    if (this.ccgMode) {
      const ccg = await fetchCcgToken(this.config)
      this.accessToken = ccg.accessToken
      this.expiresAt = Date.now() / 1000 + ccg.expiresIn - TOKEN_BUFFER_SECONDS
      return ccg.accessToken
    }
    let result: { accessToken: string; refreshToken: string; expiresIn: number }
    if (this.config.refreshFn !== undefined) {
      result = await this.config.refreshFn(this.currentRefreshToken)
    } else {
      result = await refreshAccessToken(this.config, this.currentRefreshToken)
    }
    this.accessToken = result.accessToken
    this.expiresAt = Date.now() / 1000 + result.expiresIn - TOKEN_BUFFER_SECONDS
    if (result.refreshToken !== this.currentRefreshToken) {
      this.currentRefreshToken = result.refreshToken
      if (this.config.onRefreshTokenRotated !== undefined) {
        await this.config.onRefreshTokenRotated(result.refreshToken)
      }
    }
    return result.accessToken
  }
}

export async function boxAuthHeaders(tm: BoxTokenManager): Promise<Record<string, string>> {
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
  const headers = await boxAuthHeaders(tm)
  const r = await fetch(buildUrl(url, params), { headers })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new BoxApiError(`Box GET ${url} → ${String(r.status)} ${text}`, r.status)
  }
  return r.json()
}

export async function boxGetBytes(
  tm: BoxTokenManager,
  url: string,
  params?: Record<string, string | number>,
): Promise<Uint8Array> {
  const headers = await boxAuthHeaders(tm)
  const r = await fetch(buildUrl(url, params), { headers, redirect: 'follow' })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new BoxApiError(`Box GET ${url} → ${String(r.status)} ${text}`, r.status)
  }
  const buf = await r.arrayBuffer()
  return new Uint8Array(buf)
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
