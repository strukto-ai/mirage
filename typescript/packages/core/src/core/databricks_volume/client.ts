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

import { z } from 'zod'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { ByteWindow } from '../../utils/ranges.ts'
import { apiRequest, apiStream, NO_RETRY } from '../api/client.ts'
import { DatabricksVolumeApiError, DatabricksVolumeCredentialError } from './errors.ts'
import type { DirectoryEntry, FileMetadata } from './types.ts'

type Endpoint = 'files' | 'directories'

const ENTRY = z.object({
  path: z.string(),
  is_directory: z.boolean().default(false),
  file_size: z.number().int().nonnegative().nullish(),
  last_modified: z.number().int().nullish(),
})
const PAGE = z.object({
  contents: z.array(ENTRY).default([]),
  next_page_token: z.string().nullish(),
})
const RESPONSE = z.object({ headers: z.record(z.string(), z.string()) })
const ERROR = z.object({ error_code: z.string().nullish(), message: z.string().nullish() })

function url(accessor: DatabricksVolumeAccessor, endpoint: Endpoint, path: string): string {
  const encoded = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `${accessor.host}/api/2.0/fs/${endpoint}${encoded}`
}

async function headers(accessor: DatabricksVolumeAccessor): Promise<Record<string, string>> {
  const credential = accessor.config.token
  let token: unknown
  try {
    token = typeof credential === 'function' ? await credential() : credential
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new DatabricksVolumeCredentialError(cause)
  }
  if (typeof token !== 'string' || token.trim() === '' || /[\r\n]/.test(token)) {
    throw new Error('databricks_volume: token must be a nonblank string without CR or LF')
  }
  return { Authorization: `Bearer ${token}` }
}

function errorOf(response: Response, text: string): Error {
  let payload: unknown = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  const parsed = ERROR.safeParse(payload)
  const code = parsed.success ? (parsed.data.error_code ?? null) : null
  const message = parsed.success ? (parsed.data.message ?? text) : text
  return new DatabricksVolumeApiError(
    `databricks_volume: HTTP ${String(response.status)} ${message}`,
    response.status,
    code,
  )
}

async function request(
  accessor: DatabricksVolumeAccessor,
  method: string,
  endpoint: Endpoint,
  path: string,
  options: Pick<Parameters<typeof apiRequest>[2], 'read' | 'params' | 'body' | 'window'> = {},
): Promise<unknown> {
  return apiRequest(method, url(accessor, endpoint, path), {
    ...options,
    headers: {
      ...(await headers(accessor)),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/octet-stream' }),
    },
    errorOf,
    retry: NO_RETRY,
    timeout: accessor.config.timeout,
  })
}

export async function getMetadata(
  accessor: DatabricksVolumeAccessor,
  path: string,
): Promise<FileMetadata> {
  const response = RESPONSE.parse(
    await request(accessor, 'HEAD', 'files', path, { read: 'response' }),
  )
  const length = response.headers['content-length']
  const parsed = length === undefined || length === '' ? null : Number(length)
  return {
    contentLength: parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null,
    lastModified: response.headers['last-modified'] ?? null,
  }
}

export async function getDirectoryMetadata(
  accessor: DatabricksVolumeAccessor,
  path: string,
): Promise<void> {
  await request(accessor, 'HEAD', 'directories', path, { read: 'none' })
}

/**
 * A directory's entries, a page at a time; no page past the one that
 * brings `limit` entries. Mirrors Python's `list_directory_contents`.
 */
export async function listDirectoryContents(
  accessor: DatabricksVolumeAccessor,
  path: string,
  limit?: number,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = []
  let token: string | null | undefined
  do {
    const page = PAGE.parse(
      await request(accessor, 'GET', 'directories', path, {
        params: token === undefined || token === null ? {} : { page_token: token },
      }),
    )
    entries.push(
      ...page.contents.map((entry) => ({
        path: entry.path,
        isDirectory: entry.is_directory,
        fileSize: entry.file_size ?? null,
        lastModified: entry.last_modified ?? null,
      })),
    )
    token = page.next_page_token
    if (limit !== undefined && entries.length >= limit) break
  } while (token !== undefined && token !== null && token !== '')
  return entries
}

export async function download(
  accessor: DatabricksVolumeAccessor,
  path: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  return z.instanceof(Uint8Array).parse(
    await request(accessor, 'GET', 'files', path, {
      read: 'bytes',
      window,
    }),
  )
}

export async function* downloadStream(
  accessor: DatabricksVolumeAccessor,
  path: string,
): AsyncIterable<Uint8Array> {
  const requestHeaders = await headers(accessor)
  yield* apiStream(url(accessor, 'files', path), {
    headers: requestHeaders,
    errorOf,
    timeout: accessor.config.timeout,
  })
}

// TODO(MIRAGE-32): stream the upload; this holds the whole file.
export async function upload(
  accessor: DatabricksVolumeAccessor,
  path: string,
  data: Uint8Array,
  overwrite: boolean,
): Promise<void> {
  await request(accessor, 'PUT', 'files', path, {
    params: { overwrite },
    body: new Uint8Array(data),
    read: 'none',
  })
}

export async function createDirectory(
  accessor: DatabricksVolumeAccessor,
  path: string,
): Promise<void> {
  await request(accessor, 'PUT', 'directories', path, { read: 'none' })
}

export async function deleteFile(accessor: DatabricksVolumeAccessor, path: string): Promise<void> {
  await request(accessor, 'DELETE', 'files', path, { read: 'none' })
}

export async function deleteDirectory(
  accessor: DatabricksVolumeAccessor,
  path: string,
): Promise<void> {
  await request(accessor, 'DELETE', 'directories', path, { read: 'none' })
}
