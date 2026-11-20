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
import { concat } from '../../utils/bytes.ts'
import { sha1Hex } from '../../utils/hash.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { Handed } from '../../vfs/types.ts'
import { fetchBlob, rawUrl, streamBlob, streamRaw } from './client.ts'
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
 * listing, and the next read's probe corrects it. An anonymous account on
 * github.com downloads the file instead (`rawSource`), at a commit whose tree
 * names that same sha.
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
  const url = rawSource(accessor, path, sha)
  let data: Uint8Array
  if (url === null) {
    data = await fetchBlob(accessor.account.transport, accessor.owner, accessor.repo, sha)
  } else {
    const chunks: Uint8Array[] = []
    for await (const chunk of streamRaw(accessor.account.transport, url)) chunks.push(chunk)
    data = concat(chunks)
  }
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
 * their own read. Each file kept is recorded as `read` records it. An
 * anonymous account asks nothing and leaves every file to its own read,
 * since GraphQL refuses a call with no credential. Mirrors Python's
 * `read_many`.
 */
export async function readMany(
  accessor: GitHubAccessor,
  paths: readonly PathSpec[],
  limit: number,
  handed: readonly Handed[] = [],
): Promise<Map<string, Uint8Array>> {
  if (accessor.account.anonymous) return new Map()
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
 * JSON; an anonymous account on github.com downloads the file instead, as
 * `read` does. The sha is the row's, as `read` takes it, and recorded up
 * front: the blob endpoint is content-addressed, and a download names a
 * commit whose tree holds that blob, so it names the bytes however far the
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
  const url = rawSource(accessor, path, sha)
  const source =
    url === null
      ? streamBlob(account.transport, owner, repo, sha)
      : streamRaw(account.transport, url)
  for await (const chunk of source) {
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }

  if (rec !== null) rec.complete = true
}

/**
 * The URL that downloads the blob `sha` at `path`, or null when it is asked
 * by sha.
 *
 * An anonymous account on github.com downloads files, since each blob
 * request spends one of the 60 an hour the REST API allows it. The download
 * names the commit the accessor's tree was listed at, and only when that
 * tree holds this very blob at the path, so the bytes are the ones `sha`
 * names; a row from an older listing, or a tree that names no commit, is
 * asked by sha. Mirrors Python's `_raw_source`.
 */
function rawSource(accessor: GitHubAccessor, path: PathSpec, sha: string): string | null {
  const base = accessor.account.rawBase
  const rel = stripSlash(path.mountPath)
  const row = Object.hasOwn(accessor.tree, rel) ? accessor.tree[rel] : undefined
  if (base === null || accessor.head === null || row?.sha !== sha) return null
  return rawUrl(base, accessor.owner, accessor.repo, accessor.head, rel)
}

/** The blob sha of the file at `path`, off its row. Mirrors Python's `_blob_sha`. */
function blobSha(path: PathSpec, entry: FileStat | null | undefined): string {
  if (stripSlash(path.mountPath) === '') throw eisdir(path.virtual)
  if (entry === undefined || entry === null) throw enoent(path.virtual)
  if (entry.type === FileType.DIRECTORY) throw eisdir(path.virtual)
  return entry.extra.sha as string
}
