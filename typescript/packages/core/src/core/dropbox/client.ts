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

import {
  DROPBOX_API_BASE,
  DROPBOX_CONTENT_BASE,
  DROPBOX_TOKEN_URL,
  TOKEN_BUFFER_SECONDS,
} from './constants.ts'
import { apiRequest } from '../api/client.ts'
import { TokenManager as OAuthTokenManager } from '../api/oauth.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { type ByteWindow } from '../../utils/ranges.ts'

export interface DropboxConfig {
  clientId: string
  clientSecret?: string
  refreshToken: string
  /**
   * Base URL overriding the real Dropbox hosts (integ fakes): one origin
   * serving `/oauth2/token`, the RPC API under `/2`, and content downloads
   * under `/2`. Unset means the production oauth/api/content hosts.
   */
  endpoint?: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
}

export class DropboxApiError extends Error {
  readonly status: number
  /** Dropbox `error_summary` (e.g. "path/not_found/..", "path/conflict/folder/.."). */
  readonly summary: string
  constructor(message: string, status: number, summary = '') {
    super(message)
    this.status = status
    this.summary = summary
    this.name = 'DropboxApiError'
  }
}

function summaryOf(text: string): string {
  try {
    return (JSON.parse(text) as { error_summary?: string }).error_summary ?? ''
  } catch {
    return ''
  }
}

function tokenUrlOf(config: DropboxConfig): string {
  if (config.endpoint === undefined || config.endpoint === '') return DROPBOX_TOKEN_URL
  return `${rstripSlash(config.endpoint)}/oauth2/token`
}

async function refreshAccessToken(config: DropboxConfig): Promise<[string, number]> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
  })
  if (config.clientSecret !== undefined && config.clientSecret !== '') {
    body.set('client_secret', config.clientSecret)
  }
  const data = (await apiRequest('POST', tokenUrlOf(config), {
    errorOf: (r, text) =>
      new DropboxApiError(`Dropbox token refresh → ${String(r.status)} ${text}`, r.status),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })) as { access_token: string; expires_in: number }
  return [data.access_token, data.expires_in]
}

export class DropboxTokenManager extends OAuthTokenManager {
  readonly apiBase: string
  readonly contentBase: string
  private readonly config: DropboxConfig

  constructor(config: DropboxConfig) {
    super(TOKEN_BUFFER_SECONDS)
    this.config = config
    if (config.endpoint !== undefined && config.endpoint !== '') {
      const base = `${rstripSlash(config.endpoint)}/2`
      this.apiBase = base
      this.contentBase = base
    } else {
      this.apiBase = DROPBOX_API_BASE
      this.contentBase = DROPBOX_CONTENT_BASE
    }
  }

  protected async refreshPair(): Promise<[string, number]> {
    if (this.config.refreshFn !== undefined) {
      const result = await this.config.refreshFn(this.config.refreshToken)
      return [result.accessToken, result.expiresIn]
    }
    return refreshAccessToken(this.config)
  }
}

async function dropboxAuthHeaders(tm: DropboxTokenManager): Promise<Record<string, string>> {
  const token = await tm.getToken()
  return { Authorization: `Bearer ${token}` }
}

export async function dropboxRpc(
  tm: DropboxTokenManager,
  endpoint: string,
  body: unknown,
): Promise<unknown> {
  const headers = await dropboxAuthHeaders(tm)
  return apiRequest('POST', `${tm.apiBase}${endpoint}`, {
    errorOf: (r, text) =>
      new DropboxApiError(
        `Dropbox POST ${endpoint} → ${String(r.status)} ${text}`,
        r.status,
        summaryOf(text),
      ),
    headers: { ...headers, 'Content-Type': 'application/json' },
    json: body,
  })
}

export async function dropboxUpload(
  tm: DropboxTokenManager,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const headers = await dropboxAuthHeaders(tm)
  await apiRequest('POST', `${tm.contentBase}/files/upload`, {
    errorOf: (r, text) =>
      new DropboxApiError(
        `Dropbox upload ${path} → ${String(r.status)} ${text}`,
        r.status,
        summaryOf(text),
      ),
    headers: {
      ...headers,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: data as unknown as BodyInit,
    read: 'none',
  })
}

export async function dropboxDownload(
  tm: DropboxTokenManager,
  path: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  const headers = await dropboxAuthHeaders(tm)
  const data = await apiRequest('POST', `${tm.contentBase}/files/download`, {
    errorOf: (r, text) =>
      new DropboxApiError(`Dropbox download ${path} → ${String(r.status)} ${text}`, r.status),
    headers: { ...headers, 'Dropbox-API-Arg': JSON.stringify({ path }) },
    read: 'bytes',
    window,
  })
  return data as Uint8Array
}

export async function* dropboxDownloadStream(
  tm: DropboxTokenManager,
  path: string,
): AsyncIterable<Uint8Array> {
  const headers = await dropboxAuthHeaders(tm)
  const url = `${tm.contentBase}/files/download`
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
