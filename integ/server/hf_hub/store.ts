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

import type { DatabaseSync } from 'node:sqlite'
import { BYTES, all, bytes, exec, one } from '../kit/typescript/index.ts'
import type { Minter } from '../kit/typescript/index.ts'
import { DEFAULT_REVISION } from './config.ts'
import { gitOid, repoKey, type Blob, type Ref, type Repo } from './wire.ts'
import { rstripSlash } from '../kit/typescript/index.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/hf_hub.prisma declares. Rows come back with every column, as Prisma
// returned them.
export type Db = DatabaseSync

const REPO =
  'SELECT tenant, kind, namespace, name, private, sdk, createdAt, sourceDir, downloads, likes, ' +
  'trendingScore, gated, seq FROM HfRepo'
const REF = 'SELECT tenant, repo, refType, name, sha, message FROM HfRef'
const BLOB =
  'SELECT tenant, repo, sha, path, content, oid, lfsOid, pointerSize, xetHash, lastCommit, ' +
  'lastModified, seq FROM HfBlob'

interface CommitRow {
  sha: string
  message: string
  description: string
  createdAt: string
}

function toRepo(row: Omit<Repo, 'private'> & { private: number }): Repo {
  return { ...row, private: row.private === 1 }
}

// Throws when nothing matched, as Prisma's delete did; every route looks the
// row up first.
function changeOne(db: Db, sql: string, ...params: string[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('hf_hub fake: no row matched')
}

/**
 * A commit sha, minted rather than hashed.
 *
 * The real Hub's shas are git's, over a tree the fake does not build. What
 * every caller actually needs is that a sha is 40 hex characters, unique, and
 * stable across a read, so the counter is padded into that shape. Hashing the
 * content instead would make two identical commits share a sha, which git
 * avoids only because its commit object carries a timestamp and a parent.
 */
export function mintSha(minter: Minter): string {
  return String(minter.next('commit')).padStart(40, '0')
}

export async function repoOf(
  db: Db,
  tenant: string,
  kind: string,
  namespace: string,
  name: string,
): Promise<Repo | null> {
  const row = one<Omit<Repo, 'private'> & { private: number }>(
    db,
    `${REPO} WHERE tenant = ? AND kind = ? AND namespace = ? AND name = ?`,
    tenant,
    kind,
    namespace,
    name,
  )
  return row === null ? null : toRepo(row)
}

export async function reposOfKind(db: Db, tenant: string, kind: string): Promise<Repo[]> {
  return all<Omit<Repo, 'private'> & { private: number }>(
    db,
    `${REPO} WHERE tenant = ? AND kind = ? ORDER BY seq`,
    tenant,
    kind,
  ).map(toRepo)
}

export async function refsOf(db: Db, tenant: string, repo: string): Promise<Ref[]> {
  return all<Ref>(db, `${REF} WHERE tenant = ? AND repo = ? ORDER BY name`, tenant, repo)
}

export async function refAt(
  db: Db,
  tenant: string,
  repo: string,
  refType: string,
  name: string,
): Promise<Ref | null> {
  return one<Ref>(
    db,
    `${REF} WHERE tenant = ? AND repo = ? AND refType = ? AND name = ?`,
    tenant,
    repo,
    refType,
    name,
  )
}

export async function addTag(
  db: Db,
  tenant: string,
  repo: string,
  name: string,
  sha: string,
  message: string,
): Promise<void> {
  exec(
    db,
    'INSERT INTO HfRef (tenant, repo, refType, name, sha, message) VALUES (?, ?, ?, ?, ?, ?)',
    tenant,
    repo,
    'tag',
    name,
    sha,
    message,
  )
}

export async function deleteRef(
  db: Db,
  tenant: string,
  repo: string,
  refType: string,
  name: string,
): Promise<void> {
  changeOne(
    db,
    'DELETE FROM HfRef WHERE tenant = ? AND repo = ? AND refType = ? AND name = ?',
    tenant,
    repo,
    refType,
    name,
  )
}

// Children first, then the repository row, which a missing row makes throw.
export async function deleteRepo(
  db: Db,
  tenant: string,
  kind: string,
  namespace: string,
  name: string,
): Promise<void> {
  const key = repoKey(kind, namespace, name)
  exec(db, 'DELETE FROM HfBlob WHERE tenant = ? AND repo = ?', tenant, key)
  exec(db, 'DELETE FROM HfRef WHERE tenant = ? AND repo = ?', tenant, key)
  exec(db, 'DELETE FROM HfCommit WHERE tenant = ? AND repo = ?', tenant, key)
  changeOne(
    db,
    'DELETE FROM HfRepo WHERE tenant = ? AND kind = ? AND namespace = ? AND name = ?',
    tenant,
    kind,
    namespace,
    name,
  )
}

// Newest first.
export async function commitsOf(db: Db, tenant: string, repo: string): Promise<CommitRow[]> {
  return all<CommitRow>(
    db,
    'SELECT sha, message, description, createdAt FROM HfCommit WHERE tenant = ? AND repo = ? ' +
      'ORDER BY seq DESC',
    tenant,
    repo,
  )
}

/**
 * Resolve a revision to a commit sha.
 *
 * Three spellings resolve, in the Hub's own order: a branch name, a tag name,
 * and a bare sha. Null means the revision does not exist, which the caller
 * must report as RevisionNotFound rather than as an empty tree.
 */
export async function resolveRevision(
  db: Db,
  tenant: string,
  repo: string,
  revision: string,
): Promise<string | null> {
  for (const refType of ['branch', 'tag']) {
    const ref = await refAt(db, tenant, repo, refType, revision)
    if (ref !== null) return ref.sha
  }
  const commit = one<{ sha: string }>(
    db,
    'SELECT sha FROM HfCommit WHERE tenant = ? AND repo = ? AND sha = ?',
    tenant,
    repo,
    revision,
  )
  return commit === null ? null : commit.sha
}

export async function headSha(db: Db, tenant: string, repo: string): Promise<string> {
  return (await resolveRevision(db, tenant, repo, DEFAULT_REVISION)) ?? ''
}

/**
 * When one commit was made. "" if the sha names no commit.
 *
 * A repository's modification time is this, never a blob's: `blobsAt` orders
 * by path and a commit carries every unchanged file forward with its old
 * timestamp, so the first blob is stale the moment a later commit touched
 * anything sorting after it, or only deleted something.
 */
export async function commitTime(
  db: Db,
  tenant: string,
  repo: string,
  sha: string,
): Promise<string> {
  if (sha === '') return ''
  const commit = one<{ createdAt: string }>(
    db,
    'SELECT createdAt FROM HfCommit WHERE tenant = ? AND repo = ? AND sha = ?',
    tenant,
    repo,
    sha,
  )
  return commit === null ? '' : commit.createdAt
}

export async function blobsAt(db: Db, tenant: string, repo: string, sha: string): Promise<Blob[]> {
  return all<Blob>(
    db,
    `${BLOB} WHERE tenant = ? AND repo = ? AND sha = ? ORDER BY path`,
    tenant,
    repo,
    sha,
  )
}

/** The content stored on Xet under `hash` in the account, null when none is. */
export async function xetContent(db: Db, tenant: string, hash: string): Promise<Uint8Array | null> {
  const row = one<{ content: Uint8Array }>(
    db,
    'SELECT content FROM HfBlob WHERE tenant = ? AND xetHash = ? LIMIT 1',
    tenant,
    hash,
  )
  return row === null ? null : row.content
}

export async function blobAt(
  db: Db,
  tenant: string,
  repo: string,
  sha: string,
  path: string,
): Promise<Blob | null> {
  return one<Blob>(
    db,
    `${BLOB} WHERE tenant = ? AND repo = ? AND sha = ? AND path = ?`,
    tenant,
    repo,
    sha,
    path,
  )
}

export async function createRepo(
  db: Db,
  tenant: string,
  kind: string,
  namespace: string,
  name: string,
  options: { private?: boolean; sdk?: string | null; now: string },
  minter: Minter,
): Promise<Repo> {
  exec(
    db,
    'INSERT INTO HfRepo (tenant, kind, namespace, name, private, sdk, createdAt, seq) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    tenant,
    kind,
    namespace,
    name,
    options.private === true ? 1 : 0,
    options.sdk ?? null,
    options.now,
    minter.next('repo'),
  )
  const repo = await repoOf(db, tenant, kind, namespace, name)
  if (repo === null) throw new Error(`hf_hub fake: repo ${name} vanished as it was made`)
  // A new repository is not empty on the Hub: it carries an initial commit
  // and a `main` pointing at it, which is what makes an upload to a
  // just-created repo a second commit rather than the first.
  const sha = mintSha(minter)
  exec(
    db,
    'INSERT INTO HfCommit (tenant, repo, sha, message, createdAt, seq) VALUES (?, ?, ?, ?, ?, ?)',
    tenant,
    repoKey(kind, namespace, name),
    sha,
    'initial commit',
    options.now,
    minter.next('commit_seq'),
  )
  exec(
    db,
    'INSERT INTO HfRef (tenant, repo, refType, name, sha) VALUES (?, ?, ?, ?, ?)',
    tenant,
    repoKey(kind, namespace, name),
    'branch',
    DEFAULT_REVISION,
    sha,
  )
  return repo
}

export interface Change {
  path: string
  content?: Uint8Array
  deleted?: boolean
  deletedFolder?: boolean
}

/**
 * Apply a commit: copy the parent's rows forward, then the changes on top.
 *
 * Copying is what makes a tag a pointer rather than a snapshot copy: a ref
 * that still names the parent sha keeps reading the parent's rows, untouched
 * by this commit. It is O(tree) per commit, which is right for a fake whose
 * fixtures are a few dozen small files and wrong for anything larger.
 */
export async function commitChanges(
  db: Db,
  tenant: string,
  repo: string,
  branch: string,
  changes: Change[],
  message: string,
  description: string,
  now: string,
  minter: Minter,
): Promise<string> {
  const parent = (await resolveRevision(db, tenant, repo, branch)) ?? ''
  const sha = mintSha(minter)
  exec(
    db,
    'INSERT INTO HfCommit (tenant, repo, sha, message, description, createdAt, parent, seq) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    tenant,
    repo,
    sha,
    message,
    description,
    now,
    parent,
    minter.next('commit_seq'),
  )
  const carried = new Map<string, Blob>()
  if (parent !== '') {
    for (const blob of await blobsAt(db, tenant, repo, parent)) carried.set(blob.path, blob)
  }
  for (const change of changes) {
    if (change.deletedFolder === true) {
      const prefix = `${rstripSlash(change.path)}/`
      for (const path of [...carried.keys()]) {
        if (path.startsWith(prefix)) carried.delete(path)
      }
      continue
    }
    if (change.deleted === true) {
      carried.delete(change.path)
      continue
    }
    const content = change.content ?? new Uint8Array(0)
    carried.set(change.path, {
      tenant,
      repo,
      sha,
      path: change.path,
      content,
      oid: gitOid(content),
      lfsOid: '',
      pointerSize: 0,
      xetHash: '',
      lastCommit: sha,
      lastModified: now,
      seq: minter.next('blob'),
    })
  }
  for (const blob of [...carried.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    exec(
      db,
      'INSERT INTO HfBlob (tenant, repo, sha, path, content, oid, lfsOid, pointerSize, ' +
        `xetHash, lastCommit, lastModified, seq) VALUES (?, ?, ?, ?, ${BYTES}, ?, ?, ?, ?, ?, ?, ?)`,
      tenant,
      repo,
      sha,
      blob.path,
      ...bytes(blob.content),
      blob.oid,
      blob.lfsOid,
      blob.pointerSize,
      blob.xetHash,
      blob.lastCommit,
      blob.lastModified,
      blob.seq,
    )
  }
  exec(
    db,
    'INSERT INTO HfRef (tenant, repo, refType, name, sha) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT (tenant, repo, refType, name) DO UPDATE SET sha = excluded.sha',
    tenant,
    repo,
    'branch',
    branch,
    sha,
  )
  return sha
}
