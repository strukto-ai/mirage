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

import { createHash } from 'node:crypto'
import type { JsonValue, Reply } from '../kit/typescript/index.ts'
import { RESOLVE_SEGMENT } from './config.ts'
import { rstripSlash } from '../kit/typescript/index.ts'

export interface Repo {
  tenant: string
  kind: string
  namespace: string
  name: string
  private: boolean
  sdk: string | null
  createdAt: string
  sourceDir: string
  downloads: number
  likes: number
  trendingScore: number
  gated: string
  seq: number
}

export interface Blob {
  tenant: string
  repo: string
  sha: string
  path: string
  content: Uint8Array
  oid: string
  lfsOid: string
  pointerSize: number
  xetHash: string
  lastCommit: string
  lastModified: string
  seq: number
}

export interface Ref {
  tenant: string
  repo: string
  refType: string
  name: string
  sha: string
  message: string
}

/** The flat key every child row carries: "models/acme/widget". */
export function repoKey(kind: string, namespace: string, name: string): string {
  return `${kind}/${namespace}/${name}`
}

/** The id the api renders, which drops the kind: "acme/widget". */
export function repoId(repo: Repo): string {
  return `${repo.namespace}/${repo.name}`
}

/** git's blob oid: sha1 over "blob <len>\0" then the bytes, as git computes it. */
export function gitOid(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([header, Buffer.from(content)]))
    .digest('hex')
}

export function sha256Of(content: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex')
}

/**
 * The Hub's error shape, and the header the client actually reads.
 *
 * `X-Error-Code` is not decoration: a missing repository, a missing revision
 * and a missing file are ALL 404 on the real Hub, and this header is the only
 * thing that tells them apart. A fake that omits it turns three distinct
 * failures into one, which is exactly the bug it exists to catch.
 */
export function hubError(status: number, code: string, message: string): Reply {
  return {
    status,
    body: { error: message },
    headers: { 'X-Error-Code': code, 'X-Error-Message': message },
  }
}

export function repoNotFound(): Reply {
  return hubError(404, 'RepoNotFound', 'Repository not found')
}

export function revisionNotFound(rev: string): Reply {
  return hubError(404, 'RevisionNotFound', `Invalid rev id: ${rev}`)
}

export function entryNotFound(): Reply {
  return hubError(404, 'EntryNotFound', 'Entry not found')
}

export function unauthorized(): Reply {
  return hubError(401, 'Unauthorized', 'Invalid username or password.')
}

/**
 * One row of a tree listing.
 *
 * `size` is the CONTENT length even for an LFS file, and the pointer length
 * rides `lfs.pointerSize` instead. Getting that backwards is the single most
 * damaging thing a Hub client can do, so the fake states both and the battery
 * asserts the content one.
 *
 * `lastCommit` and `lastModified` appear only under `expand=true`, because a
 * bare listing does not carry them and a client that reads an mtime off one
 * has to be told it is absent rather than handed a zero.
 */
export function treeRow(blob: Blob, expand: boolean): JsonValue {
  const row: Record<string, JsonValue> = {
    type: 'file',
    oid: blob.oid,
    size: blob.content.length,
    path: blob.path,
  }
  if (blob.lfsOid !== '') {
    row.lfs = {
      oid: blob.lfsOid,
      size: blob.content.length,
      pointerSize: blob.pointerSize,
    }
  }
  if (blob.xetHash !== '') row.xetHash = blob.xetHash
  if (expand) {
    row.lastCommit = { id: blob.lastCommit, title: 'seed', date: blob.lastModified }
  }
  return row
}

export function dirRow(path: string, expand: boolean, oid: string, date: string): JsonValue {
  const row: Record<string, JsonValue> = { type: 'directory', oid, size: 0, path }
  if (expand) row.lastCommit = { id: oid, title: 'seed', date }
  return row
}

/** The web url of a repository, which the create endpoint answers with. */
export function repoUrl(origin: string, kind: string, namespace: string, name: string): string {
  const segment = RESOLVE_SEGMENT[kind] ?? ''
  const base = `${rstripSlash(origin)}/${segment === '' ? '' : `${segment}/`}`
  return `${base}${namespace}/${name}`
}
