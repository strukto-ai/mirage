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
import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import { boundedMap } from '../../concurrency/limiter.ts'
import { ByteSpool } from '../../io/spool.ts'
import { encodeBase64 } from '../../utils/base64.ts'
import type { ByteWindow } from '../../utils/ranges.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  apiRequest,
  apiStream,
  NO_RETRY,
  type ApiRequestOptions,
  type ApiResponse,
} from '../api/client.ts'
import {
  BATCH_STAT_LIMIT,
  MAX_UPLOAD_WORKERS,
  PRESIGN_BATCH,
  SMALL_FILE_LIMIT,
  TREE_DELETE_RETRY,
} from './constants.ts'
import { errorOf, hasStatus, TiDBFilesystemApiError } from './errors.ts'
import type { Entry } from './types.ts'

const ListedEntry = z.object({
  name: z.string(),
  size: z.number().int().nonnegative().default(0),
  isDir: z.boolean().default(false),
  mtime: z.number().int().nullish(),
})
const Listing = z.object({ entries: z.array(ListedEntry).default([]) })
const StatResult = z.object({
  status: z.number().int(),
  size: z.number().int().nonnegative().default(0),
  isDir: z.boolean().default(false),
  mtime: z.number().int().nullish(),
  error: z.string().nullish(),
})
const BatchStat = z.object({ results: z.array(StatResult) })
const Upload = z.object({
  upload_id: z.string(),
  part_size: z.number().int().positive(),
  total_parts: z.number().int().positive(),
})
const PresignedPart = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  size: z.number().int().nonnegative(),
  headers: z.record(z.string(), z.string()).default({}),
})
const Presigned = z.object({ parts: z.array(PresignedPart) })
const AppendPart = PresignedPart.extend({
  read_url: z.string().nullish(),
  read_headers: z.record(z.string(), z.string()).default({}),
})
const AppendPlan = z.object({
  upload_id: z.string(),
  part_size: z.number().int().positive(),
  base_size: z.number().int().nonnegative(),
  upload_parts: z.array(AppendPart).default([]),
})
const BYTES = z.instanceof(Uint8Array)

function url(accessor: TiDBFilesystemAccessor, remotePath: string): string {
  const encoded = remotePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `${accessor.config.host}/v1/fs${encoded}`
}

function headers(accessor: TiDBFilesystemAccessor): Record<string, string> {
  return { Authorization: `Bearer ${accessor.config.token}` }
}

function nameOf(remotePath: string): string {
  const stripped = rstripSlash(remotePath)
  return stripped.slice(stripped.lastIndexOf('/') + 1) || '/'
}

function mtimeOf(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null
}

function sizeOf(data: Uint8Array | ByteSpool): number {
  return data instanceof ByteSpool ? data.size : data.byteLength
}

async function sliceOf(
  data: Uint8Array | ByteSpool,
  start: number,
  size: number,
): Promise<Uint8Array> {
  return data instanceof ByteSpool ? data.read(start, size) : data.slice(start, start + size)
}

function request(
  accessor: TiDBFilesystemAccessor,
  method: string,
  target: string,
  options: Omit<ApiRequestOptions, 'errorOf'> = {},
): Promise<unknown> {
  return apiRequest(method, target, {
    ...options,
    headers: {
      ...headers(accessor),
      ...(options.json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    errorOf,
    retry: options.retry ?? NO_RETRY,
    timeoutSeconds: accessor.config.timeout,
  })
}

/**
 * One path's metadata, from a HEAD. drive9 keeps a file and a directory of
 * one name apart: the bare path answers the file when there is one, and the
 * path with a trailing slash answers the directory.
 */
export async function statEntry(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
  directory = false,
): Promise<Entry> {
  const target = directory ? `${rstripSlash(remotePath)}/` : remotePath
  const response = (await request(accessor, 'HEAD', url(accessor, target), {
    read: 'response',
  })) as ApiResponse
  const isDir = response.headers['x-dat9-isdir'] === 'true'
  return {
    name: nameOf(remotePath),
    isDir,
    size: isDir ? 0 : Number(response.headers['content-length'] ?? '0'),
    mtime: mtimeOf(response.headers['x-dat9-mtime']),
  }
}

/**
 * Each path's metadata, null for a missing one, in as few requests as
 * fs:batch-stat allows.
 */
export async function statEntries(
  accessor: TiDBFilesystemAccessor,
  remotePaths: readonly string[],
): Promise<(Entry | null)[]> {
  const found: (Entry | null)[] = []
  for (let start = 0; start < remotePaths.length; start += BATCH_STAT_LIMIT) {
    const chunk = remotePaths.slice(start, start + BATCH_STAT_LIMIT)
    const { results } = BatchStat.parse(
      await request(accessor, 'POST', `${accessor.config.host}/v1/fs:batch-stat`, {
        json: { paths: chunk },
      }),
    )
    if (results.length !== chunk.length) {
      throw new TiDBFilesystemApiError('fs:batch-stat answered a different number of paths', 502)
    }
    chunk.forEach((remotePath, index) => {
      const result = results[index]
      if (result === undefined || result.status === 404) {
        found.push(null)
        return
      }
      if (result.status !== 200) {
        throw new TiDBFilesystemApiError(
          result.error ?? `HTTP ${String(result.status)}`,
          result.status,
        )
      }
      found.push({
        name: nameOf(remotePath),
        isDir: result.isDir,
        size: result.isDir ? 0 : result.size,
        mtime: result.mtime ?? null,
      })
    })
  }
  return found
}

export async function listEntries(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
): Promise<Entry[]> {
  const { entries } = Listing.parse(
    await request(accessor, 'GET', url(accessor, remotePath), { params: { list: '1' } }),
  )
  return entries.map((entry) => ({
    name: entry.name,
    isDir: entry.isDir,
    size: entry.size,
    mtime: entry.mtime ?? null,
  }))
}

/**
 * A file's bytes. A large file answers with a redirect to its object, which
 * fetch follows with the Range and without the token.
 */
export async function download(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
  window?: ByteWindow,
): Promise<Uint8Array> {
  return BYTES.parse(
    await request(accessor, 'GET', url(accessor, remotePath), { read: 'bytes', window }),
  )
}

export async function* downloadStream(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
): AsyncIterable<Uint8Array> {
  yield* apiStream(url(accessor, remotePath), {
    headers: headers(accessor),
    errorOf,
    signal: AbortSignal.timeout(Math.ceil(accessor.config.timeout * 1000)),
  })
}

async function putPart(
  accessor: TiDBFilesystemAccessor,
  part: z.infer<typeof PresignedPart>,
  body: Uint8Array,
): Promise<string> {
  const response = (await apiRequest('PUT', part.url, {
    headers: Object.fromEntries(
      Object.entries(part.headers).filter(([key]) => key.toLowerCase() !== 'host'),
    ),
    body: body as unknown as BodyInit,
    errorOf,
    retry: NO_RETRY,
    read: 'response',
    timeoutSeconds: accessor.config.timeout,
  })) as ApiResponse
  return response.headers.etag ?? ''
}

async function abort(
  accessor: TiDBFilesystemAccessor,
  method: string,
  target: string,
): Promise<void> {
  try {
    await request(accessor, method, target, { read: 'none' })
  } catch (err) {
    console.debug(`tidb_filesystem: abort ${target} failed:`, err)
  }
}

async function uploadParts(
  accessor: TiDBFilesystemAccessor,
  upload: z.infer<typeof Upload>,
  data: Uint8Array | ByteSpool,
): Promise<{ number: number; etag: string }[]> {
  const host = accessor.config.host
  const put = async (
    part: z.infer<typeof PresignedPart>,
  ): Promise<{ number: number; etag: string }> => {
    const body = await sliceOf(data, (part.number - 1) * upload.part_size, part.size)
    return { number: part.number, etag: await putPart(accessor, part, body) }
  }
  const parts: { number: number; etag: string }[] = []
  for (let first = 1; first <= upload.total_parts; first += PRESIGN_BATCH) {
    const last = Math.min(first + PRESIGN_BATCH, upload.total_parts + 1)
    const numbers = Array.from({ length: last - first }, (_, i) => ({ part_number: first + i }))
    const presigned = Presigned.parse(
      await request(accessor, 'POST', `${host}/v2/uploads/${upload.upload_id}/presign-batch`, {
        json: { parts: numbers },
      }),
    )
    parts.push(...(await boundedMap(presigned.parts, put, MAX_UPLOAD_WORKERS)))
  }
  return parts
}

async function uploadMultipart(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
  data: Uint8Array | ByteSpool,
): Promise<void> {
  const host = accessor.config.host
  const upload = Upload.parse(
    await request(accessor, 'POST', `${host}/v2/uploads/initiate`, {
      json: { path: remotePath, total_size: sizeOf(data) },
    }),
  )
  try {
    const parts = await uploadParts(accessor, upload, data)
    await request(accessor, 'POST', `${host}/v2/uploads/${upload.upload_id}/complete`, {
      json: { parts },
      read: 'none',
    })
  } catch (exc) {
    await abort(accessor, 'POST', `${host}/v2/uploads/${upload.upload_id}/abort`)
    throw exc
  }
}

/**
 * Replace a file's bytes: one PUT below the inline threshold, a multipart
 * upload through presigned part URLs from it on, each part read from `data`
 * as it goes up.
 */
export async function upload(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
  data: Uint8Array | ByteSpool,
): Promise<void> {
  const size = sizeOf(data)
  if (size >= SMALL_FILE_LIMIT) {
    await uploadMultipart(accessor, remotePath, data)
    return
  }
  await request(accessor, 'PUT', url(accessor, remotePath), {
    headers: { 'Content-Type': 'application/octet-stream' },
    body: (await sliceOf(data, 0, size)) as unknown as BodyInit,
    read: 'none',
  })
}

/**
 * Add bytes to the end of a file drive9 keeps in object storage. The server
 * copies the parts the bytes leave alone into a new upload, the last part's
 * own bytes come back through its read URL, and they go up again with the
 * new ones. False, with nothing sent, for a file drive9 keeps inline (400) or
 * a path that is not a file (404).
 */
export async function appendTo(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
  data: Uint8Array | ByteSpool,
): Promise<boolean> {
  const host = accessor.config.host
  const size = sizeOf(data)
  let raw: unknown
  try {
    raw = await request(accessor, 'POST', url(accessor, remotePath), {
      params: { append: '' },
      json: { append_size: size },
    })
  } catch (err) {
    if (!(hasStatus(err, 400) || hasStatus(err, 404))) throw err
    console.debug('tidb_filesystem: no native append:', err)
    return false
  }
  const plan = AppendPlan.parse(raw)
  const kept = (part: z.infer<typeof AppendPart>): number => {
    const start = (part.number - 1) * plan.part_size
    return Math.max(0, Math.min(plan.base_size, start + part.size) - start)
  }
  const put = async (part: z.infer<typeof AppendPart>): Promise<string> => {
    const own = kept(part)
    let original = new Uint8Array()
    if (own > 0 && part.read_url != null) {
      original = BYTES.parse(
        await apiRequest('GET', part.read_url, {
          headers: part.read_headers,
          errorOf,
          retry: NO_RETRY,
          read: 'bytes',
          timeoutSeconds: accessor.config.timeout,
        }),
      )
    }
    const start = (part.number - 1) * plan.part_size + own - plan.base_size
    const added = part.size > own ? await sliceOf(data, start, part.size - own) : new Uint8Array()
    if (original.byteLength !== own || added.byteLength !== part.size - own) {
      throw new TiDBFilesystemApiError(
        `append part ${String(part.number)} does not match its plan`,
        502,
      )
    }
    const body = new Uint8Array(part.size)
    body.set(original)
    body.set(added, own)
    return putPart(accessor, part, body)
  }
  try {
    const covered = plan.upload_parts.reduce((sum, part) => sum + part.size - kept(part), 0)
    if (covered !== size) {
      throw new TiDBFilesystemApiError('the append plan does not cover the appended bytes', 502)
    }
    await boundedMap(plan.upload_parts, put, MAX_UPLOAD_WORKERS)
    await request(accessor, 'POST', `${host}/v1/uploads/${plan.upload_id}/complete`, {
      read: 'none',
    })
  } catch (exc) {
    await abort(accessor, 'DELETE', `${host}/v1/uploads/${plan.upload_id}`)
    throw exc
  }
  return true
}

export async function makeDirectory(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
): Promise<void> {
  await request(accessor, 'POST', url(accessor, remotePath), {
    params: { mkdir: '' },
    read: 'none',
  })
}

/** Remove one entry of the given kind; a directory must be empty. */
export async function remove(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
  kind: 'file' | 'dir',
): Promise<void> {
  await request(accessor, 'DELETE', url(accessor, remotePath), {
    params: { kind },
    read: 'none',
  })
}

export async function removeTree(
  accessor: TiDBFilesystemAccessor,
  remotePath: string,
): Promise<void> {
  await request(accessor, 'DELETE', url(accessor, remotePath), {
    params: { recursive: '1' },
    retry: TREE_DELETE_RETRY,
    read: 'none',
  })
}

export async function move(
  accessor: TiDBFilesystemAccessor,
  remoteSrc: string,
  remoteDst: string,
): Promise<void> {
  const source = encodeBase64(new TextEncoder().encode(remoteSrc))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  await request(accessor, 'POST', url(accessor, remoteDst), {
    headers: { 'X-Dat9-Rename-Source': source, 'X-Dat9-Path-Encoding': 'base64url' },
    params: { rename: '' },
    read: 'none',
  })
}
