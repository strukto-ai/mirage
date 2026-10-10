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
  RESULT_HEADER,
} from './constants.ts'
import { type ApiResponse, apiRequest, loweredHeaders } from '../api/client.ts'
import { TokenManager as OAuthTokenManager } from '../api/oauth.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { type ByteWindow } from '../../utils/ranges.ts'
import type { JsonValue } from '../../types.ts'

// The Dropbox-API-Arg header carries JSON, and a header is a ByteString:
// a path with a character past U+00FF makes fetch refuse the request.
// Dropbox reads JSON escapes there, so every non-ASCII character goes as
// \uXXXX, which is what python's json.dumps sends by default.
function headerJson(arg: Record<string, JsonValue>): string {
  return JSON.stringify(arg).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

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

/** An error body's `error_summary`, or '' when it carries no string. */
function summaryOf(text: string): string {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return ''
  }
  if (typeof body !== 'object' || body === null) return ''
  const summary = (body as Record<string, unknown>).error_summary
  return typeof summary === 'string' ? summary : ''
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

/**
 * Upload one file, overwriting, and return the reply as decoded. Given a
 * `rev`, the upload goes in `update` mode: Dropbox stores it only while the
 * file is still that revision, and answers a 409 `path/conflict` otherwise.
 *
 * The reply is the stored FileMetadata; it is not checked here, since the
 * upload has landed once the call returns and the writer's `uploadToken`
 * reads it without throwing.
 */
export async function dropboxUpload(
  tm: DropboxTokenManager,
  path: string,
  data: Uint8Array,
  rev: string | null = null,
): Promise<unknown> {
  const headers = await dropboxAuthHeaders(tm)
  const arg: Record<string, JsonValue> =
    rev === null
      ? { path, mode: 'overwrite', mute: true }
      : { path, mode: { '.tag': 'update', update: rev }, mute: true, autorename: false }
  const resp = (await apiRequest('POST', `${tm.contentBase}/files/upload`, {
    errorOf: (r, text) =>
      new DropboxApiError(
        `Dropbox upload ${path} → ${String(r.status)} ${text}`,
        r.status,
        summaryOf(text),
      ),
    headers: {
      ...headers,
      'Dropbox-API-Arg': headerJson(arg),
      'Content-Type': 'application/octet-stream',
    },
    body: data as unknown as BodyInit,
    read: 'response',
  })) as ApiResponse
  return resp.data
}

/**
 * Download a file, or a byte range of it, with its result header: the raw
 * `Dropbox-API-Result`, or null when the response carries none
 * (`fingerprint.resultOf` reads it).
 */
export async function dropboxDownload(
  tm: DropboxTokenManager,
  path: string,
  window?: ByteWindow,
): Promise<[Uint8Array, string | null]> {
  const headers = await dropboxAuthHeaders(tm)
  const resp = (await apiRequest('POST', `${tm.contentBase}/files/download`, {
    errorOf: (r, text) =>
      new DropboxApiError(
        `Dropbox download ${path} → ${String(r.status)} ${text}`,
        r.status,
        summaryOf(text),
      ),
    headers: { ...headers, 'Dropbox-API-Arg': headerJson({ path }) },
    read: 'bytes_response',
    window,
  })) as ApiResponse
  return [resp.data as Uint8Array, resp.headers[RESULT_HEADER.toLowerCase()] ?? null]
}

/**
 * Stream a file's bytes; `onResponse` is handed its headers, lower-cased as
 * `bytes_response` hands them, before the first chunk.
 */
export async function* dropboxDownloadStream(
  tm: DropboxTokenManager,
  path: string,
  onResponse?: (headers: Record<string, string>) => void,
): AsyncIterable<Uint8Array> {
  const headers = await dropboxAuthHeaders(tm)
  const url = `${tm.contentBase}/files/download`
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Dropbox-API-Arg': headerJson({ path }) },
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new DropboxApiError(
      `Dropbox download ${path} → ${String(r.status)} ${text}`,
      r.status,
      summaryOf(text),
    )
  }
  try {
    onResponse?.(loweredHeaders(r.headers))
  } catch (err) {
    await r.body?.cancel().catch((cancelErr: unknown) => {
      console.debug(`Dropbox download ${path}: body cancel failed`, cancelErr)
    })
    throw err
  }
  if (r.body === null) return
  const reader = r.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield value
  }
}
