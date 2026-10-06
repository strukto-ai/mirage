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

import { publishRead } from '../../cache/context.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { Sha1, sha1Hex } from '../../utils/hash.ts'
import { downloadFile, downloadFileStream } from './api.ts'
import { entryToken, readToken } from './fingerprint.ts'
import { readdir } from './readdir.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { windowFor } from '../../utils/ranges.ts'

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Box accessor.
 *   path: the path to read.
 *   index: listing cache, consulted for the file id.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const window = windowFor(options?.offset ?? 0, options?.size ?? null)
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`

  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry = await entryOrWarm(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'box/folder') throw eisdir(path.virtual)
  const timer = startOp()
  const data = await downloadFile(accessor.tokenManager, entry.id, window)
  // Only a whole read through a row with a sha1 can yield a token, so nothing
  // else is hashed. The token never depends on a recorder being bound
  // (read_revalidatable.test.ts holds each declarer to it). A whole buffer
  // prefers WebCrypto's native SHA-1, falling back to incremental Sha1
  // when unavailable. Streams use incremental Sha1 without buffering.
  const hashable = window === undefined && entryToken(entry) !== null
  const fingerprint = hashable ? readToken(entry, await sha1Hex(data)) : null
  publishRead(path.virtual, data, fingerprint)
  record('read', path.virtual, 'box', data.byteLength, timer, {
    fingerprint,
  })
  return data
}

/**
 * Stream a file, stamped with its sha1 once it has been read whole. When a
 * token can result (a recorder is bound and the row has a sha1), each chunk
 * feeds a running SHA-1; the token lands only after the last chunk, so a
 * stream abandoned part-way stamps nothing.
 *
 * Args:
 *   accessor: Box accessor.
 *   path: the path to read.
 *   index: listing cache, consulted for the file id.
 */
export async function* readStream(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) p = p.slice(prefix.length) || '/'
  const key = stripSlash(p)
  if (key === '') throw eisdir(path.virtual)
  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`

  const parentKey = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
  const entry = await entryOrWarm(
    index,
    virtualKey,
    parentKey !== virtualKey
      ? () => readdir(accessor, PathSpec.fromStrPath(parentKey, mountKey(parentKey, prefix)), index)
      : null,
  )
  if (entry === null) throw enoent(path.virtual)
  if (entry.resourceType === 'box/folder') throw eisdir(path.virtual)
  const rec = recordStream('read', path.virtual, 'box')
  const digest = rec !== null && entryToken(entry) !== null ? new Sha1() : null
  for await (const chunk of downloadFileStream(accessor.tokenManager, entry.id)) {
    digest?.update(chunk)
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
  if (rec !== null && digest !== null) rec.fingerprint = readToken(entry, digest.digest())
}
