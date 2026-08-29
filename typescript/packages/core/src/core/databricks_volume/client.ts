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

import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { TokenProvider } from '../../resource/databricks_volume/token_provider.ts'
import { DatabricksVolumeApiError } from './errors.ts'

export type DbxEndpoint = 'files' | 'directories'

export interface DbxFetchOptions {
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: Uint8Array | string
}

export function encodeRemotePath(remotePath: string): string {
  return remotePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

export function dbxUrl(
  accessor: DatabricksVolumeAccessor,
  endpoint: DbxEndpoint,
  remotePath: string,
  query?: Record<string, string>,
): string {
  let url = `${accessor.host}/api/2.0/fs/${endpoint}${encodeRemotePath(remotePath)}`
  if (query !== undefined && Object.keys(query).length > 0) {
    url += `?${new URLSearchParams(query).toString()}`
  }
  return url
}

/**
 * The bearer token for one operation, awaited whether or not it is async.
 *
 * @throws when the provider answered with something that is not a usable
 * token; sending `Bearer ` alone would come back as an opaque 401 instead.
 */
export async function resolveToken(provider: TokenProvider): Promise<string> {
  const token = await provider.getToken()
  if (typeof token !== 'string' || token === '') {
    throw new Error('databricks_volume: token provider returned an empty token')
  }
  return token
}

async function errorFromResponse(method: string, url: string, r: Response): Promise<Error> {
  let errorCode: string | null = null
  let message = ''
  const text = await r.text().catch(() => '')
  try {
    const data = JSON.parse(text) as { error_code?: string; message?: string }
    errorCode = data.error_code ?? null
    message = data.message ?? text
  } catch {
    message = text
  }
  return new DatabricksVolumeApiError(
    `databricks_volume: ${method} ${url} → ${String(r.status)} ${message}`,
    r.status,
    errorCode,
  )
}

export async function dbxFetch(
  accessor: DatabricksVolumeAccessor,
  method: string,
  endpoint: DbxEndpoint,
  remotePath: string,
  options: DbxFetchOptions = {},
): Promise<Response> {
  const url = dbxUrl(accessor, endpoint, remotePath, options.query)
  // Resolved per request and never stored: the provider owns caching and
  // refresh, and a 401 is reported rather than replayed with a new token,
  // because an on-behalf-of provider cannot re-mint a user's credential and
  // a write must not be sent twice.
  const token = await resolveToken(accessor.tokenProvider)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...options.headers,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, accessor.config.timeout * 1000)
  let r: Response
  try {
    r = await fetch(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: options.body as BodyInit } : {}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!r.ok) {
    throw await errorFromResponse(method, url, r)
  }
  return r
}
