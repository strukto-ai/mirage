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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ListedMiss } from '../../cache/index/config.ts'
import { entryOrListedMiss } from '../../cache/index/warm.ts'
import { publishRead, writesConditioned } from '../../cache/context.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { DropboxApiError, dropboxDownload, dropboxDownloadStream } from './client.ts'
import { MISS_SUMMARIES, NOT_FILE_SUMMARY, RESULT_HEADER } from './constants.ts'
import { resultOf, resultToken } from './fingerprint.ts'
import { readdir } from './readdir.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { windowFor } from '../../utils/ranges.ts'

function dropboxPathFromVirtual(root: string, virtualKey: string, prefix: string): string {
  let key = virtualKey
  if (prefix !== '' && key.startsWith(prefix)) key = key.slice(prefix.length)
  key = stripSlash(key)
  return key === '' ? root : `${root}/${key}`
}

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
 * Refuse a download by path that found the name in another case.
 *
 * Dropbox matches a path case-insensitively, a listing does not: a file stored
 * as `N` is not `n`. Only a name the result spells otherwise refuses: a result
 * without one proves nothing, and calling it absent would let a write go out
 * over a file that is there. Mirrors Python's `_check_name`.
 */
function checkName(path: PathSpec, result: Record<string, unknown> | null): void {
  const key = stripSlash(path.vfsPath)
  const named = result?.name
  if (typeof named === 'string' && named !== key.slice(key.lastIndexOf('/') + 1)) {
    throw enoent(path.virtual)
  }
}

/**
 * Whether a read goes by path, with the index key and mount prefix: by path
 * when the cached listing that omits the name is one the running command did
 * not fetch. Throws ENOENT or EISDIR for what the index answers. Mirrors
 * Python's `_resolve_read`.
 */
async function resolveRead(
  accessor: DropboxAccessor,
  path: PathSpec,
  index: IndexCacheStore,
): Promise<[boolean, string, string]> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry = await entryOrListedMiss(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === ListedMiss.UNTRUSTED) return [true, virtualKey, prefix]
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'dropbox/folder') throw eisdir(path.virtual)
  return [false, virtualKey, prefix]
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
  const [byPath, virtualKey, prefix] =
    index === undefined
      ? [true, path.virtual, mountPrefixOf(path.virtual, path.vfsPath)]
      : await resolveRead(accessor, path, index)
  const dropboxPath = dropboxPathFromVirtual(accessor.rootPath, virtualKey, prefix)
  const timer = startOp()
  let download: [Uint8Array, string | null]
  try {
    download = await dropboxDownload(accessor.tokenManager, dropboxPath, window)
  } catch (err) {
    const refusal = byPath ? byPathRefusal(path, err) : null
    if (refusal !== null) throw refusal
    throw err
  }
  const [data, result] = download
  const meta = resultOf(result)
  if (byPath) checkName(path, meta)
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
  if (index === undefined) throw enoent(path.virtual)
  const [byPath, virtualKey, prefix] = await resolveRead(accessor, path, index)
  const dropboxPath = dropboxPathFromVirtual(accessor.rootPath, virtualKey, prefix)
  const rec = recordStream('read', path.virtual, 'dropbox')
  const stamp = (headers: Record<string, string>): void => {
    const meta = resultOf(headers[RESULT_HEADER.toLowerCase()])
    if (byPath) checkName(path, meta)
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
