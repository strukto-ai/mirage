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

import type { Minter } from '../kit/typescript/index.ts'
import { CAS_TENANT, type C } from './config.ts'
import type { HfObject } from './wire.ts'
import { decodeXorb, parseShardFiles, serveHash } from './xet.ts'

function objectKey(
  tenant: string,
  bucket: string,
  path: string,
): { tenant_bucket_path: { tenant: string; bucket: string; path: string } } {
  return { tenant_bucket_path: { tenant, bucket, path } }
}

export async function objects(db: C, tenant: string, bucket: string): Promise<HfObject[]> {
  return db.hfObject.findMany({ where: { tenant, bucket }, orderBy: { path: 'asc' } })
}

export async function objectAt(
  db: C,
  tenant: string,
  bucket: string,
  path: string,
): Promise<HfObject | null> {
  return db.hfObject.findUnique({ where: objectKey(tenant, bucket, path) })
}

/**
 * Bind a path to content already in the CAS.
 *
 * The sha256 goes into the CAS too, because that is the hash the tree
 * advertises and every read path resolves through; the shard's own file hash
 * addresses the same bytes and is what named them here.
 *
 * Args:
 *   db (C): the run's client.
 *   tenant (string): the account.
 *   bucket (string): the vendor's `namespace/name`.
 *   path (string): the key being written.
 *   content (Uint8Array): the file's bytes.
 *   modified (string): the stamp to record.
 *   minter (Minter): source of the etag and the row's sequence.
 */
export async function writeObject(
  db: C,
  tenant: string,
  bucket: string,
  path: string,
  content: Uint8Array,
  modified: string,
  minter: Minter,
): Promise<void> {
  const n = minter.next('object')
  const row = {
    content: content as Uint8Array<ArrayBuffer>,
    etag: `hf-etag-${String(n)}`,
    modified,
    seq: n,
  }
  await db.hfObject.upsert({
    where: objectKey(tenant, bucket, path),
    create: { tenant, bucket, path, ...row },
    update: row,
  })
  await putXetFile(db, serveHash(content), content)
}

export async function deleteObject(
  db: C,
  tenant: string,
  bucket: string,
  path: string,
): Promise<void> {
  await db.hfObject.deleteMany({ where: { tenant, bucket, path } })
}

export async function deleteFolder(
  db: C,
  tenant: string,
  bucket: string,
  path: string,
): Promise<void> {
  await db.hfObject.deleteMany({ where: { tenant, bucket, path: { startsWith: `${path}/` } } })
}

export async function putXetFile(db: C, hash: string, raw: Uint8Array): Promise<void> {
  const content = raw as Uint8Array<ArrayBuffer>
  await db.hfXetFile.upsert({
    where: { tenant_hash: { tenant: CAS_TENANT, hash } },
    create: { tenant: CAS_TENANT, hash, content },
    update: { content },
  })
}

export async function xetFile(db: C, hash: string): Promise<Uint8Array | null> {
  const row = await db.hfXetFile.findUnique({
    where: { tenant_hash: { tenant: CAS_TENANT, hash } },
  })
  return row === null ? null : row.content
}

export async function putXorb(db: C, hash: string, body: Buffer): Promise<void> {
  const { content, offsets } = decodeXorb(body)
  const row = { content: content as Uint8Array<ArrayBuffer>, offsets: JSON.stringify(offsets) }
  await db.hfXorb.upsert({
    where: { tenant_hash: { tenant: CAS_TENANT, hash } },
    create: { tenant: CAS_TENANT, hash, ...row },
    update: row,
  })
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
 *   db (C): the run's client.
 *   body (Buffer): the uploaded shard.
 */
export async function registerShard(db: C, body: Buffer): Promise<void> {
  for (const file of parseShardFiles(body)) {
    const parts: Buffer[] = []
    for (const entry of file.entries) {
      const row = await db.hfXorb.findUnique({
        where: { tenant_hash: { tenant: CAS_TENANT, hash: entry.casHash } },
      })
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
