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
import { CAS_TENANT } from './config.ts'
import type { HfObject, TreeRow } from './wire.ts'
import { decodeXorb, parseShardFiles, serveHash } from './xet.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/hf.prisma declares.
type Db = DatabaseSync

const OBJECT = 'SELECT tenant, bucket, path, content, etag, modified, seq FROM HfObject'

// The bucket's objects without their bytes: a listing used to read every
// object's content to render the few files directly under one folder.
export async function objectRows(db: Db, tenant: string, bucket: string): Promise<TreeRow[]> {
  return all<TreeRow>(
    db,
    'SELECT path, modified FROM HfObject WHERE tenant = ? AND bucket = ? ORDER BY path',
    tenant,
    bucket,
  )
}

export async function objectsAt(
  db: Db,
  tenant: string,
  bucket: string,
  paths: string[],
): Promise<HfObject[]> {
  if (paths.length === 0) return []
  return all<HfObject>(
    db,
    `${OBJECT} WHERE tenant = ? AND bucket = ? AND path IN (SELECT value FROM json_each(?))`,
    tenant,
    bucket,
    JSON.stringify(paths),
  )
}

export async function objectAt(
  db: Db,
  tenant: string,
  bucket: string,
  path: string,
): Promise<HfObject | null> {
  return one<HfObject>(
    db,
    `${OBJECT} WHERE tenant = ? AND bucket = ? AND path = ?`,
    tenant,
    bucket,
    path,
  )
}

/**
 * Bind a path to content already in the CAS.
 *
 * The sha256 goes into the CAS too, because that is the hash the tree
 * advertises and every read path resolves through; the shard's own file hash
 * addresses the same bytes and is what named them here.
 *
 * Args:
 *   db (Db): the run's file.
 *   tenant (string): the account.
 *   bucket (string): the vendor's `namespace/name`.
 *   path (string): the key being written.
 *   content (Uint8Array): the file's bytes.
 *   modified (string): the stamp to record.
 *   minter (Minter): source of the etag and the row's sequence.
 */
export async function writeObject(
  db: Db,
  tenant: string,
  bucket: string,
  path: string,
  content: Uint8Array,
  modified: string,
  minter: Minter,
): Promise<void> {
  const n = minter.next('object')
  exec(
    db,
    'INSERT INTO HfObject (tenant, bucket, path, content, etag, modified, seq) ' +
      `VALUES (?, ?, ?, ${BYTES}, ?, ?, ?) ON CONFLICT (tenant, bucket, path) DO UPDATE SET ` +
      'content = excluded.content, etag = excluded.etag, modified = excluded.modified, ' +
      'seq = excluded.seq',
    tenant,
    bucket,
    path,
    ...bytes(content),
    `hf-etag-${String(n)}`,
    modified,
    n,
  )
  await putXetFile(db, serveHash(content), content)
}

export async function deleteObject(
  db: Db,
  tenant: string,
  bucket: string,
  path: string,
): Promise<void> {
  exec(
    db,
    'DELETE FROM HfObject WHERE tenant = ? AND bucket = ? AND path = ?',
    tenant,
    bucket,
    path,
  )
}

// `startsWith` as Prisma ran it on SQLite: LIKE with the prefix unescaped, so
// ASCII case is ignored and `%` or `_` match as wildcards. Kept exactly.
export async function deleteFolder(
  db: Db,
  tenant: string,
  bucket: string,
  path: string,
): Promise<void> {
  exec(
    db,
    'DELETE FROM HfObject WHERE tenant = ? AND bucket = ? AND path LIKE ?',
    tenant,
    bucket,
    `${path}/%`,
  )
}

export async function putXetFile(db: Db, hash: string, content: Uint8Array): Promise<void> {
  exec(
    db,
    `INSERT INTO HfXetFile (tenant, hash, content) VALUES (?, ?, ${BYTES}) ` +
      'ON CONFLICT (tenant, hash) DO UPDATE SET content = excluded.content',
    CAS_TENANT,
    hash,
    ...bytes(content),
  )
}

export async function xetFile(db: Db, hash: string): Promise<Uint8Array | null> {
  const row = one<{ content: Uint8Array }>(
    db,
    'SELECT content FROM HfXetFile WHERE tenant = ? AND hash = ?',
    CAS_TENANT,
    hash,
  )
  return row === null ? null : row.content
}

export async function putXorb(db: Db, hash: string, body: Buffer): Promise<void> {
  const { content, offsets } = decodeXorb(body)
  exec(
    db,
    `INSERT INTO HfXorb (tenant, hash, content, offsets) VALUES (?, ?, ${BYTES}, ?) ` +
      'ON CONFLICT (tenant, hash) DO UPDATE SET content = excluded.content, ' +
      'offsets = excluded.offsets',
    CAS_TENANT,
    hash,
    ...bytes(content),
    JSON.stringify(offsets),
  )
}

/**
 * Reconstruct every file an uploaded shard describes, and store it by hash.
 *
 * A shard is the step that turns anonymous CAS blocks into named content: each
 * record says which chunk ranges of which xorbs, in order, make up one file
 * hash. The client sends it before it sends the commit that binds a path, so
 * this is where a file first exists as bytes.
 *
 * Args:
 *   db (Db): the run's file.
 *   body (Buffer): the uploaded shard.
 */
export async function registerShard(db: Db, body: Buffer): Promise<void> {
  for (const file of parseShardFiles(body)) {
    const parts: Buffer[] = []
    for (const entry of file.entries) {
      const row = one<{ content: Uint8Array; offsets: string }>(
        db,
        'SELECT content, offsets FROM HfXorb WHERE tenant = ? AND hash = ?',
        CAS_TENANT,
        entry.casHash,
      )
      if (row === null) throw new Error(`shard names an unknown xorb ${entry.casHash}`)
      const offsets = JSON.parse(row.offsets) as number[]
      const from = offsets[entry.start] ?? 0
      const to = offsets[entry.end] ?? 0
      const segment = Buffer.from(row.content).subarray(from, to)
      if (segment.length !== entry.unpacked) throw new Error('shard segment length mismatch')
      parts.push(segment)
    }
    await putXetFile(db, file.fileHash, Buffer.concat(parts))
  }
}
