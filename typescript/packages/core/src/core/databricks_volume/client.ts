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
import { DatabricksVolumeApiError, DatabricksVolumeAuthError } from './errors.ts'

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
  const rendered = `databricks_volume: ${method} ${url} → ${String(r.status)} ${message}`
  // A refused credential is its own type, because it is the one failure the
  // application can act on: obtain a fresh token and rebuild the resource.
  // Nothing here retries or replays.
  if (r.status === 401) {
    return new DatabricksVolumeAuthError(rendered, r.status, errorCode)
  }
  return new DatabricksVolumeApiError(rendered, r.status, errorCode)
}

export async function dbxFetch(
  accessor: DatabricksVolumeAccessor,
  method: string,
  endpoint: DbxEndpoint,
  remotePath: string,
  options: DbxFetchOptions = {},
): Promise<Response> {
  const url = dbxUrl(accessor, endpoint, remotePath, options.query)
  // The token the config carries. A 401 is reported rather than replayed:
  // the same refused credential would go out again, and for a write it would
  // send the write twice.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessor.config.token}`,
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
