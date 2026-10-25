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
import { sha1Hex } from '../../utils/hash.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { Handed } from '../../vfs/types.ts'
import { fetchBlob, streamBlob } from './client.ts'
import { BLOB_TEXT } from './constants.ts'
import { graphqlData } from './repo.ts'

const ENC = new TextEncoder()

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
 * Several files' blobs in one GraphQL query.
 *
 * Each blob is asked by the sha its row names, as `read` asks it. GraphQL
 * hands a blob over as text, so a file is kept only when that text, encoded
 * as UTF-8, hashes to the sha the way git hashes a blob, which proves the
 * bytes are the ones a read returns. A binary, truncated or non-UTF-8 blob, a
 * file past `limit` bytes, and a path with no file row are left out for
 * their own read. Each file kept is recorded as `read` records it. Mirrors
 * Python's `read_many`.
 */
export async function readMany(
  accessor: GitHubAccessor,
  paths: readonly PathSpec[],
  limit: number,
  handed: readonly Handed[] = [],
): Promise<Map<string, Uint8Array>> {
  const asked = new Map<string, [string, string]>()
  for (const [i, path] of paths.entries()) {
    const entry = handed[i]?.entry ?? null
    if (entry === null || entry.type === FileType.DIRECTORY || (entry.size ?? 0) > limit) continue
    asked.set(`f${String(asked.size)}`, [path.virtual, String(entry.extra.sha)])
  }
  const answers = new Map<string, Uint8Array>()
  if (asked.size === 0) return answers
  const aliases = [...asked.keys()]
  const declared = aliases.map((alias) => `, $${alias}: GitObjectID!`).join('')
  const fields = aliases
    .map((alias) => `${alias}: object(oid: $${alias}) { ${BLOB_TEXT} }`)
    .join(' ')
  const timer = startOp()
  const data = await graphqlData(
    accessor.account.transport,
    `query($owner: String!, $repo: String!${declared}) ` +
      `{ repository(owner: $owner, name: $repo) { ${fields} } }`,
    {
      owner: accessor.owner,
      repo: accessor.repo,
      ...Object.fromEntries([...asked].map(([alias, [, sha]]) => [alias, sha])),
    },
  )
  const blobs = (data.repository ?? {}) as Record<string, unknown>
  for (const [alias, [virtual, sha]] of asked) {
    const blob = blobs[alias] as { text?: unknown; isTruncated?: unknown } | null | undefined
    if (blob === null || blob === undefined || blob.isTruncated === true) continue
    if (typeof blob.text !== 'string') continue
    const body = ENC.encode(blob.text)
    if (body.byteLength > limit) continue
    const header = ENC.encode(`blob ${String(body.byteLength)}\0`)
    const framed = new Uint8Array(header.byteLength + body.byteLength)
    framed.set(header)
    framed.set(body, header.byteLength)
    if ((await sha1Hex(framed)) !== sha) continue
    record('read', virtual, VFSName.GITHUB, body.byteLength, timer, { fingerprint: sha })
    answers.set(virtual, body)
  }
  return answers
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
