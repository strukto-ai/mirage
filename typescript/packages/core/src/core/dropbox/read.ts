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
import { MISS_SUMMARIES, NOT_FILE_SUMMARY, RESULT_HEADER } from './constants.ts'
import { resultOf, resultToken } from './fingerprint.ts'
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
 * What a download Dropbox refused means, or null. Only a miss is ENOENT (a
 * file the listing named that is gone) and a folder's path EISDIR; any other
 * refusal (restricted_content, a 5xx) names a file that may exist, and is
 * thrown as Dropbox sent it. Mirrors Python's `_refusal`.
 */
function refusal(path: PathSpec, err: unknown): Error | null {
  if (!(err instanceof DropboxApiError) || err.status !== 409) return null
  if (MISS_SUMMARIES.some((miss) => err.summary.startsWith(miss))) return enoent(path.virtual)
  if (err.summary.startsWith(NOT_FILE_SUMMARY)) return eisdir(path.virtual)
  return null
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
  return readByPath(accessor, path, options)
}

/**
 * Download whatever file Dropbox resolves `path` to, in any case. A rewrite
 * (`truncate`) reads this way where no listing names the file: its upload
 * lands on that same file, so calling a file stored as `N` absent for `n`
 * would zero it. Mirrors Python's `read_by_path`.
 */
export async function readByPath(
  accessor: DropboxAccessor,
  path: PathSpec,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const window = windowFor(options?.offset ?? 0, options?.size ?? null)
  const timer = startOp()
  let download: [Uint8Array, string | null]
  try {
    download = await dropboxDownload(accessor.tokenManager, dropboxPathOf(accessor, path), window)
  } catch (err) {
    throw refusal(path, err) ?? err
  }
  const [data, result] = download
  const token = resultToken(resultOf(result))
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
    if (rec !== null) {
      rec.fingerprint = resultToken(resultOf(headers[RESULT_HEADER.toLowerCase()]))
    }
  }
  try {
    for await (const chunk of dropboxDownloadStream(
      accessor.tokenManager,
      dropboxPathOf(accessor, path),
      stamp,
    )) {
      if (rec !== null) rec.bytes += chunk.byteLength
      yield chunk
    }
  } catch (err) {
    throw refusal(path, err) ?? err
  }
}
