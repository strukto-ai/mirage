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

import type { Clock } from '../kit/typescript/index.ts'
import type { C } from './config.ts'

// The vendor's generation is a 64-bit number rendered as a string, and
// fake-gcs-server mints it from the wall clock in MICROseconds. The python
// client sends it straight back as `?generation=` on a delete, so it only has
// to be stable and to look like a number. Minted off the kit clock rather than
// Date.now() so a /reset that pins an epoch pins these too.
export function nextGeneration(clock: Clock): string {
  return String(clock.nowMs() * 1000)
}

export async function bucketOf(db: C, tenant: string, name: string) {
  return db.gcsBucket.findUnique({ where: { tenant_name: { tenant, name } } })
}

export async function bucketsOf(db: C, tenant: string, prefix: string) {
  const rows = await db.gcsBucket.findMany({ where: { tenant }, orderBy: { name: 'asc' } })
  return prefix === '' ? rows : rows.filter((row) => row.name.startsWith(prefix))
}

export async function objectOf(db: C, tenant: string, bucket: string, name: string) {
  return db.gcsObject.findUnique({ where: { tenant_bucket_name: { tenant, bucket, name } } })
}

export async function objectsOf(db: C, tenant: string, bucket: string, prefix: string) {
  const rows = await db.gcsObject.findMany({
    where: { tenant, bucket },
    orderBy: { name: 'asc' },
  })
  return prefix === '' ? rows : rows.filter((row) => row.name.startsWith(prefix))
}

/**
 * Store one object, replacing any object of the same name.
 *
 * `timeCreated` is kept from the row being replaced, which is what the vendor
 * does for an overwrite of a live object: the bq proxy's header restore reads
 * an object the emulator just wrote and writes it back one line longer, and a
 * creation time that moved on that write would make the object look newer than
 * the extract job that produced it.
 */
export async function putObject(
  db: C,
  tenant: string,
  bucket: string,
  name: string,
  content: Buffer,
  contentType: string,
  clock: Clock,
) {
  const prior = await objectOf(db, tenant, bucket, name)
  const now = clock.nowIso()
  const row = {
    tenant,
    bucket,
    name,
    // A pooled Buffer is a view onto a shared ArrayBuffer, which Prisma's Bytes
    // does not accept; copying is what makes the stored bytes this object's.
    content: new Uint8Array(content),
    contentType,
    timeCreated: prior?.timeCreated ?? now,
    updated: now,
    generation: nextGeneration(clock),
  }
  return db.gcsObject.upsert({
    where: { tenant_bucket_name: { tenant, bucket, name } },
    create: { ...row, seq: await nextSeq(db, tenant) },
    update: row,
  })
}

// Insertion order, which the kit's seeder writes and every listable table
// carries. Reads here order by NAME rather than by seq, because that is what
// the vendor's listing does and what the bq proxy's wildcard resolution
// depends on; seq is kept so a fixture round-trips unchanged.
async function nextSeq(db: C, tenant: string): Promise<number> {
  return db.gcsObject.count({ where: { tenant } })
}

export async function bucketIsEmpty(db: C, tenant: string, name: string): Promise<boolean> {
  return (await db.gcsObject.count({ where: { tenant, bucket: name } })) === 0
}

// Pending resumable sessions die WITH the bucket: a session that outlived it
// accepted its remaining chunks and wrote an orphan object, or wrote into a
// recreated bucket of the same name, which is another world's data.
export async function deleteBucket(db: C, tenant: string, name: string): Promise<void> {
  await db.gcsUpload.deleteMany({ where: { tenant, bucket: name } })
  await db.gcsBucket.delete({ where: { tenant_name: { tenant, name } } })
}
