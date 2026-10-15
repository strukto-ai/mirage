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

import { publishRead, writesConditioned } from '../../cache/context.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import { Sha1, sha1Hex } from '../../utils/hash.ts'
import { downloadFile, downloadFileStream } from './api.ts'
import { entryToken, readToken } from './fingerprint.ts'
import { stripSlash } from '../../utils/slash.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { windowFor } from '../../utils/ranges.ts'

/**
 * What is at the file `path`, as its parent's listing named it. Throws ENOENT
 * when nothing is there and EISDIR when a folder is. Mirrors Python's
 * `file_entry`.
 */
export function fileEntry(path: PathSpec, entry: FileStat | null | undefined): FileStat {
  if (stripSlash(path.vfsPath) === '') throw eisdir(path.virtual)
  if (entry === null || entry === undefined) throw enoent(path.virtual)
  if (entry.type === FileType.DIRECTORY) throw eisdir(path.virtual)
  return entry
}

/**
 * Read a file, optionally only a byte range of it. On a `write: conditional`
 * mount a whole read stamps its bytes' own sha1, even through an outdated
 * listing row.
 *
 * Args:
 *   accessor: Box accessor.
 *   path: the path to read.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 *   entry: what is at the path.
 */
export async function read(
  accessor: BoxAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
  entry?: FileStat | null,
): Promise<Uint8Array> {
  const window = windowFor(options?.offset ?? 0, options?.size ?? null)
  const found = fileEntry(path, entry)
  const timer = startOp()
  const data = await downloadFile(accessor.tokenManager, found.extra.box_id as string, window)
  // Only a whole read through a row with a sha1 can yield a token, so nothing
  // else is hashed. The token never depends on a recorder being bound
  // (read_revalidatable.test.ts holds each declarer to it). A whole buffer
  // prefers WebCrypto's native SHA-1, falling back to incremental Sha1
  // when unavailable. Streams use incremental Sha1 without buffering.
  const hashable = window === undefined && entryToken(found) !== null
  const digest = hashable ? await sha1Hex(data) : null
  let fingerprint: string | null = null
  if (digest !== null) fingerprint = writesConditioned(path) ? digest : readToken(found, digest)
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
 * stream abandoned part-way stamps nothing. The token is chosen as `read`
 * chooses it.
 *
 * Args:
 *   accessor: Box accessor.
 *   path: the path to read.
 *   entry: what is at the path.
 */
export async function* readStream(
  accessor: BoxAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): AsyncIterable<Uint8Array> {
  const found = fileEntry(path, entry)
  const rec = recordStream('read', path.virtual, 'box')
  const conditioned = writesConditioned(path)
  const digest = rec !== null && entryToken(found) !== null ? new Sha1() : null
  for await (const chunk of downloadFileStream(
    accessor.tokenManager,
    found.extra.box_id as string,
  )) {
    digest?.update(chunk)
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
  if (rec !== null && digest !== null) {
    const token = digest.digest()
    rec.fingerprint = conditioned ? token : readToken(found, token)
  }
}
