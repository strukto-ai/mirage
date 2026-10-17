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

import type { GitHubAccessor } from '../../accessor/github.ts'
import { record, recordStream, startOp } from '../../observe/context.ts'
import { FileType, type FileStat, type PathSpec, VFSName } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { fetchBlob, streamBlob } from './client.ts'

/**
 * Read a file's blob and record the sha it was fetched by.
 *
 * The sha comes from the file's row, as its folder's listing names it. The
 * blob endpoint is content-addressed, so the recorded sha names exactly the
 * bytes returned however old the listing is. That is also the documented
 * limit of `read: fresh` here: a file read for the first time comes from the
 * listing, and the next read's probe corrects it.
 *
 * Mirrors Python's `read`.
 */
export async function read(
  accessor: GitHubAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<Uint8Array> {
  const sha = blobSha(path, entry)
  const timer = startOp()
  const data = await fetchBlob(accessor.account.transport, accessor.owner, accessor.repo, sha)
  record('read', path.virtual, VFSName.GITHUB, data.length, timer, { fingerprint: sha })
  return data
}

/**
 * Stream a file's blob as it downloads, recorded by its sha. The blob comes
 * as GitHub's raw media type, the bytes themselves rather than base64 inside
 * JSON. The sha is the row's, as `read` takes it, and recorded up front: the
 * blob endpoint is content-addressed, so it names the bytes however far the
 * stream is read. Mirrors Python's `read_stream`.
 */
export async function* readStream(
  accessor: GitHubAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): AsyncGenerator<Uint8Array, void> {
  const sha = blobSha(path, entry)
  const rec = recordStream('read', path.virtual, VFSName.GITHUB, { fingerprint: sha })
  const { account, owner, repo } = accessor
  for await (const chunk of streamBlob(account.transport, owner, repo, sha)) {
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
}

/** The blob sha of the file at `path`, off its row. Mirrors Python's `_blob_sha`. */
function blobSha(path: PathSpec, entry: FileStat | null | undefined): string {
  if (stripSlash(path.mountPath) === '') throw eisdir(path.virtual)
  if (entry === undefined || entry === null) throw enoent(path.virtual)
  if (entry.type === FileType.DIRECTORY) throw eisdir(path.virtual)
  return entry.extra.sha as string
}
