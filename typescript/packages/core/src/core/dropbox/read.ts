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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ListedMiss } from '../../cache/index/config.ts'
import { publishRead, writesConditioned } from '../../cache/context.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import type { PathSpec } from '../../types.ts'
import { resolveListedEntry } from '../hierarchy/probe.ts'
import { DropboxApiError, dropboxDownload, dropboxDownloadStream } from './client.ts'
import { MISS_SUMMARIES, NOT_FILE_SUMMARY, RESULT_HEADER } from './constants.ts'
import { resultOf, resultToken } from './fingerprint.ts'
import { dropboxPathOf, spelledOtherwise } from './paths.ts'
import { readdir } from './readdir.ts'
import { stripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { windowFor } from '../../utils/ranges.ts'

/**
 * What a download by path that Dropbox refused means, or null to raise it as
 * is: only a miss is ENOENT and a folder's path EISDIR; any other refusal
 * (restricted_content, a 5xx) names a file that may exist. Mirrors Python's
 * `_by_path_refusal`.
 */
function byPathRefusal(path: PathSpec, err: unknown): Error | null {
  if (!(err instanceof DropboxApiError) || err.status !== 409) return null
  if (MISS_SUMMARIES.some((miss) => err.summary.startsWith(miss))) return enoent(path.virtual)
  if (err.summary.startsWith(NOT_FILE_SUMMARY)) return eisdir(path.virtual)
  return null
}

/**
 * Whether a read goes by path: by path when the cached listing that omits the
 * name is one the running command did not fetch. Throws ENOENT or EISDIR for
 * what the index answers. Mirrors Python's `_resolve_read`.
 */
async function resolveRead(
  accessor: DropboxAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<boolean> {
  if (stripSlash(path.vfsPath) === '') throw eisdir(path.virtual)
  const entry = await resolveListedEntry(readdir, accessor, path, index)
  if (entry === ListedMiss.UNTRUSTED) return true
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'dropbox/folder') throw eisdir(path.virtual)
  return false
}

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Dropbox accessor.
 *   path: the path to read.
 *   index: listing cache, consulted for the entry.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const window = windowFor(options?.offset ?? 0, options?.size ?? null)
  // Index-less callers (emulated truncate) download by path.
  const byPath = index === undefined || (await resolveRead(accessor, path, index))
  const timer = startOp()
  let download: [Uint8Array, string | null]
  try {
    download = await dropboxDownload(accessor.tokenManager, dropboxPathOf(accessor, path), window)
  } catch (err) {
    const refusal = byPath ? byPathRefusal(path, err) : null
    if (refusal !== null) throw refusal
    throw err
  }
  const [data, result] = download
  const meta = resultOf(result)
  if (byPath && spelledOtherwise(path, meta)) throw enoent(path.virtual)
  const token = resultToken(meta)
  record('read', path.virtual, 'dropbox', data.byteLength, timer, { fingerprint: token })
  if (window === undefined && writesConditioned(path)) publishRead(path.virtual, data, token)
  return data
}

export async function* readStream(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const byPath = await resolveRead(accessor, path, index)
  const dropboxPath = dropboxPathOf(accessor, path)
  const rec = recordStream('read', path.virtual, 'dropbox')
  const stamp = (headers: Record<string, string>): void => {
    const meta = resultOf(headers[RESULT_HEADER.toLowerCase()])
    if (byPath && spelledOtherwise(path, meta)) throw enoent(path.virtual)
    if (rec !== null) rec.fingerprint = resultToken(meta)
  }
  try {
    for await (const chunk of dropboxDownloadStream(accessor.tokenManager, dropboxPath, stamp)) {
      if (rec !== null) rec.bytes += chunk.byteLength
      yield chunk
    }
  } catch (err) {
    const refusal = byPath ? byPathRefusal(path, err) : null
    if (refusal !== null) throw refusal
    throw err
  }
}
