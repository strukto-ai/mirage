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

export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
export const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2'
export const DROPBOX_CONTENT_BASE = 'https://content.dropboxapi.com/2'
const TOKEN_BUFFER_SECONDS = 300

export interface DropboxConfig {
  clientId: string
  clientSecret?: string
  refreshToken: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
}

export class DropboxApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'DropboxApiError'
  }
}

export async function refreshAccessToken(config: DropboxConfig): Promise<[string, number]> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
  })
  if (config.clientSecret !== undefined && config.clientSecret !== '') {
    body.set('client_secret', config.clientSecret)
  }
  const r = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new DropboxApiError(`Dropbox token refresh → ${String(r.status)} ${text}`, r.status)
  }
  const data = (await r.json()) as { access_token: string; expires_in: number }
  return [data.access_token, data.expires_in]
}

export class DropboxTokenManager {
  private readonly config: DropboxConfig
  private accessToken: string | null = null
  private expiresAt = 0
  private inflight: Promise<string> | null = null

  constructor(config: DropboxConfig) {
    this.config = config
  }

  async getToken(): Promise<string> {
    if (this.accessToken !== null && Date.now() / 1000 < this.expiresAt) {
      return this.accessToken
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
    let token: string
    let expiresIn: number
    if (this.config.refreshFn !== undefined) {
      const result = await this.config.refreshFn(this.config.refreshToken)
      token = result.accessToken
      expiresIn = result.expiresIn
    } else {
      ;[token, expiresIn] = await refreshAccessToken(this.config)
    }
    this.accessToken = token
    this.expiresAt = Date.now() / 1000 + expiresIn - TOKEN_BUFFER_SECONDS
    return token
  }
}

export async function dropboxAuthHeaders(tm: DropboxTokenManager): Promise<Record<string, string>> {
  const token = await tm.getToken()
  return { Authorization: `Bearer ${token}` }
}

export async function dropboxRpc(
  tm: DropboxTokenManager,
  endpoint: string,
  body: unknown,
): Promise<unknown> {
  const headers = await dropboxAuthHeaders(tm)
  const url = `${DROPBOX_API_BASE}${endpoint}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new DropboxApiError(`Dropbox POST ${endpoint} → ${String(r.status)} ${text}`, r.status)
  }
  return r.json()
}

export async function dropboxDownload(tm: DropboxTokenManager, path: string): Promise<Uint8Array> {
  const headers = await dropboxAuthHeaders(tm)
  const url = `${DROPBOX_CONTENT_BASE}/files/download`
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Dropbox-API-Arg': JSON.stringify({ path }) },
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new DropboxApiError(`Dropbox download ${path} → ${String(r.status)} ${text}`, r.status)
  }
  const buf = await r.arrayBuffer()
  return new Uint8Array(buf)
}

export async function* dropboxDownloadStream(
  tm: DropboxTokenManager,
  path: string,
): AsyncIterable<Uint8Array> {
  const headers = await dropboxAuthHeaders(tm)
  const url = `${DROPBOX_CONTENT_BASE}/files/download`
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Dropbox-API-Arg': JSON.stringify({ path }) },
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new DropboxApiError(`Dropbox download ${path} → ${String(r.status)} ${text}`, r.status)
  }
  if (r.body === null) return
  const reader = r.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield value
  }
}
