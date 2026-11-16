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
import type { Clock } from '../kit/typescript/index.ts'

// The run's file over node:sqlite (kit sql.ts), on the tables
// prisma/gcs.prisma declares. Rows come back with every column, as Prisma
// returned them.
type Db = DatabaseSync

interface BucketRecord {
  tenant: string
  name: string
  project: string
  timeCreated: string
  updated: string
  seq: number
}

interface ObjectRecord {
  tenant: string
  bucket: string
  name: string
  content: Uint8Array
  contentType: string
  timeCreated: string
  updated: string
  generation: string
  seq: number
}

interface UploadRecord {
  tenant: string
  id: string
  bucket: string
  name: string
  contentType: string
  content: Uint8Array
  seq: number
}

const BUCKET = 'SELECT tenant, name, project, timeCreated, updated, seq FROM GcsBucket'
const OBJECT =
  'SELECT tenant, bucket, name, content, contentType, timeCreated, updated, generation, seq ' +
  'FROM GcsObject'
const UPLOAD = 'SELECT tenant, id, bucket, name, contentType, content, seq FROM GcsUpload'

// Throws when nothing matched, as Prisma's update and delete did; every route
// looks the row up first.
function changeOne(db: Db, sql: string, ...params: (string | number | Uint8Array | null)[]): void {
  if (exec(db, sql, ...params) === 0) throw new Error('gcs fake: no row matched')
}

// The vendor's generation is a 64-bit number rendered as a string, and
// fake-gcs-server mints it from the wall clock in MICROseconds. The python
// client sends it straight back as `?generation=` on a delete, so it only has
// to be stable and to look like a number. Minted off the kit clock rather than
// Date.now() so a /reset that pins an epoch pins these too.
export function nextGeneration(clock: Clock): string {
  return String(clock.nowMs() * 1000)
}

export async function bucketOf(db: Db, tenant: string, name: string): Promise<BucketRecord | null> {
  return one<BucketRecord>(db, `${BUCKET} WHERE tenant = ? AND name = ?`, tenant, name)
}

export async function bucketsOf(db: Db, tenant: string, prefix: string): Promise<BucketRecord[]> {
  return all<BucketRecord>(
    db,
    `${BUCKET} WHERE tenant = ? AND substr(name, 1, length(?)) = ? ORDER BY name`,
    tenant,
    prefix,
    prefix,
  )
}

export async function addBucket(
  db: Db,
  tenant: string,
  name: string,
  project: string,
  now: string,
): Promise<BucketRecord> {
  exec(
    db,
    'INSERT INTO GcsBucket (tenant, name, project, timeCreated, updated, seq) ' +
      'VALUES (?, ?, ?, ?, ?, (SELECT COUNT(*) FROM GcsBucket WHERE tenant = ?))',
    tenant,
    name,
    project,
    now,
    now,
    tenant,
  )
  const made = await bucketOf(db, tenant, name)
  if (made === null) throw new Error(`gcs fake: bucket ${name} vanished as it was made`)
  return made
}

export async function objectOf(
  db: Db,
  tenant: string,
  bucket: string,
  name: string,
): Promise<ObjectRecord | null> {
  return one<ObjectRecord>(
    db,
    `${OBJECT} WHERE tenant = ? AND bucket = ? AND name = ?`,
    tenant,
    bucket,
    name,
  )
}

export async function objectsOf(
  db: Db,
  tenant: string,
  bucket: string,
  prefix: string,
): Promise<ObjectRecord[]> {
  return all<ObjectRecord>(
    db,
    `${OBJECT} WHERE tenant = ? AND bucket = ? AND substr(name, 1, length(?)) = ? ORDER BY name`,
    tenant,
    bucket,
    prefix,
    prefix,
  )
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
  db: Db,
  tenant: string,
  bucket: string,
  name: string,
  content: Buffer,
  contentType: string,
  clock: Clock,
): Promise<ObjectRecord> {
  const prior = await objectOf(db, tenant, bucket, name)
  const now = clock.nowIso()
  exec(
    db,
    'INSERT INTO GcsObject ' +
      '(tenant, bucket, name, content, contentType, timeCreated, updated, generation, seq) ' +
      `VALUES (?, ?, ?, ${BYTES}, ?, ?, ?, ?, (SELECT COUNT(*) FROM GcsObject WHERE tenant = ?)) ` +
      'ON CONFLICT (tenant, bucket, name) DO UPDATE SET content = excluded.content, ' +
      'contentType = excluded.contentType, timeCreated = excluded.timeCreated, ' +
      'updated = excluded.updated, generation = excluded.generation',
    tenant,
    bucket,
    name,
    ...bytes(content),
    contentType,
    prior?.timeCreated ?? now,
    now,
    nextGeneration(clock),
    tenant,
  )
  const made = await objectOf(db, tenant, bucket, name)
  if (made === null) throw new Error(`gcs fake: object ${name} vanished as it was written`)
  return made
}

export async function deleteObject(
  db: Db,
  tenant: string,
  bucket: string,
  name: string,
): Promise<void> {
  changeOne(
    db,
    'DELETE FROM GcsObject WHERE tenant = ? AND bucket = ? AND name = ?',
    tenant,
    bucket,
    name,
  )
}

export async function bucketIsEmpty(db: Db, tenant: string, name: string): Promise<boolean> {
  const found = one<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM GcsObject WHERE tenant = ? AND bucket = ?',
    tenant,
    name,
  )
  return (found?.n ?? 0) === 0
}

// Pending resumable sessions die WITH the bucket: a session that outlived it
// accepted its remaining chunks and wrote an orphan object, or wrote into a
// recreated bucket of the same name, which is another world's data.
export async function deleteBucket(db: Db, tenant: string, name: string): Promise<void> {
  exec(db, 'DELETE FROM GcsUpload WHERE tenant = ? AND bucket = ?', tenant, name)
  changeOne(db, 'DELETE FROM GcsBucket WHERE tenant = ? AND name = ?', tenant, name)
}

export async function openUpload(
  db: Db,
  tenant: string,
  id: string,
  bucket: string,
  name: string,
  contentType: string,
): Promise<void> {
  exec(
    db,
    'INSERT INTO GcsUpload (tenant, id, bucket, name, contentType, content, seq) ' +
      "VALUES (?, ?, ?, ?, ?, X'', (SELECT COUNT(*) FROM GcsUpload WHERE tenant = ?))",
    tenant,
    id,
    bucket,
    name,
    contentType,
    tenant,
  )
}

export async function uploadOf(db: Db, tenant: string, id: string): Promise<UploadRecord | null> {
  return one<UploadRecord>(db, `${UPLOAD} WHERE tenant = ? AND id = ?`, tenant, id)
}

export async function growUpload(
  db: Db,
  tenant: string,
  id: string,
  content: Buffer,
): Promise<void> {
  changeOne(
    db,
    `UPDATE GcsUpload SET content = ${BYTES} WHERE tenant = ? AND id = ?`,
    ...bytes(content),
    tenant,
    id,
  )
}

export async function dropUpload(db: Db, tenant: string, id: string): Promise<void> {
  changeOne(db, 'DELETE FROM GcsUpload WHERE tenant = ? AND id = ?', tenant, id)
}
