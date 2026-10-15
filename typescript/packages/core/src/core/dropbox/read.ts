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
import { publishRead, writesConditioned } from '../../cache/context.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import { DropboxApiError, dropboxDownload, dropboxDownloadStream } from './client.ts'
import { RESULT_HEADER } from './constants.ts'
import { resultToken } from './fingerprint.ts'
import { dropboxPathOf } from './paths.ts'
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
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: Dropbox accessor.
 *   path: the path to read.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 *   entry: what is at the path.
 */
export async function read(
  accessor: DropboxAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
  entry?: FileStat | null,
): Promise<Uint8Array> {
  fileEntry(path, entry)
  const window = windowFor(options?.offset ?? 0, options?.size ?? null)
  const timer = startOp()
  let download: [Uint8Array, string | null]
  try {
    download = await dropboxDownload(accessor.tokenManager, dropboxPathOf(accessor, path), window)
  } catch (err) {
    // The listing named a file Dropbox no longer has there.
    if (err instanceof DropboxApiError && err.status === 409) throw enoent(path.virtual)
    throw err
  }
  const [data, result] = download
  const token = resultToken(result)
  record('read', path.virtual, 'dropbox', data.byteLength, timer, { fingerprint: token })
  if (window === undefined && writesConditioned(path)) publishRead(path.virtual, data, token)
  return data
}

/** Stream a file, stamped with its content_hash. Mirrors Python's `read_stream`. */
export async function* readStream(
  accessor: DropboxAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): AsyncIterable<Uint8Array> {
  fileEntry(path, entry)
  const rec = recordStream('read', path.virtual, 'dropbox')
  const stamp = (headers: Record<string, string>): void => {
    if (rec !== null) rec.fingerprint = resultToken(headers[RESULT_HEADER.toLowerCase()])
  }
  for await (const chunk of dropboxDownloadStream(
    accessor.tokenManager,
    dropboxPathOf(accessor, path),
    stamp,
  )) {
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
}
