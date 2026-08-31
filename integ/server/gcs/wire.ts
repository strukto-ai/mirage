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

// CRC32C (Castagnoli), which is NOT the crc32 node has anywhere. It is here
// because the python client VALIDATES it: a resumable upload compares the
// checksum the server reports against the one it computed and raises
// DataCorruption on a mismatch, so a fake that reports a constant or omits the
// field fails the seeder rather than the assertion it was written for. Probed:
// reporting "AAAAAA==" aborts `blob.open("wb")` at the first chunk.
const POLY = 0x82f63b78
const TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1
    t[i] = c
  }
  return t
})()

export function crc32c(data: Uint8Array): string {
  let crc = 0xffffffff
  for (const byte of data) crc = (crc >>> 8) ^ (TABLE[(crc ^ byte) & 0xff] ?? 0)
  crc = (crc ^ 0xffffffff) >>> 0
  // Big-endian, which is how the vendor base64s it.
  const out = Buffer.alloc(4)
  out.writeUInt32BE(crc, 0)
  return out.toString('base64')
}

export function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('base64')
}

// The vendor's error envelope, which the CLI reads `error.message` out of and
// reports to the agent. `reason` is the machine-readable half; only `notFound`
// and `conflict` are ever produced here.
export function errorReply(status: number, message: string, reason: string): Reply {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        errors: [{ domain: 'global', reason, message }],
      },
    },
  }
}

export function notFound(): Reply {
  return errorReply(404, 'Not Found', 'notFound')
}

// Verbatim from the real service, and from fake-gcs-server, which is what this
// fake replaces. The wording matters only in that the CLI prints it.
export function bucketConflict(name: string): Reply {
  return errorReply(
    409,
    `A Cloud Storage bucket named '${name}' already exists. Try another name. ` +
      'Bucket names must be globally unique across all Google Cloud projects, ' +
      'including those outside of your organization.',
    'conflict',
  )
}

// `alt=media` answers in the object's own media type, so a miss on that path
// is plain text rather than the JSON envelope. fake-gcs-server answers the
// bare word; matching it keeps a caller that greps stderr working.
export function mediaNotFound(): Reply {
  return {
    status: 404,
    body: Buffer.from('Not Found'),
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }
}

export interface BucketRow {
  name: string
  project: string
  timeCreated: string
  updated: string
}

export interface ObjectRow {
  bucket: string
  name: string
  content: Uint8Array
  contentType: string
  timeCreated: string
  updated: string
  generation: string
}

// An object name is a path, so it is escaped whole: a `/` in it is `%2F` in
// the link, which is the spelling the client sends back.
function esc(name: string): string {
  return encodeURIComponent(name)
}

export function bucketBody(row: BucketRow, base: string): JsonValue {
  return {
    kind: 'storage#bucket',
    id: row.name,
    name: row.name,
    projectNumber: '0',
    metageneration: '1',
    location: 'US-CENTRAL1',
    locationType: 'region',
    storageClass: 'STANDARD',
    defaultEventBasedHold: false,
    versioning: { enabled: false },
    timeCreated: row.timeCreated,
    updated: row.updated,
    etag: 'RVRhZw==',
    selfLink: `${base}/storage/v1/b/${esc(row.name)}`,
  }
}

// `etag` IS the md5, which is what the vendor does for a single-part upload and
// what every consumer here compares against nothing at all. `size` is a string
// because the vendor renders a 64-bit count as one, and the python client
// int()s it back.
export function objectBody(row: ObjectRow, base: string): JsonValue {
  const digest = md5(row.content)
  return {
    kind: 'storage#object',
    id: `${row.bucket}/${row.name}`,
    name: row.name,
    bucket: row.bucket,
    size: String(row.content.length),
    contentType: row.contentType,
    crc32c: crc32c(row.content),
    md5Hash: digest,
    etag: digest,
    storageClass: 'STANDARD',
    timeCreated: row.timeCreated,
    timeStorageClassUpdated: row.timeCreated,
    updated: row.updated,
    generation: row.generation,
    metageneration: '1',
    selfLink: `${base}/storage/v1/b/${esc(row.bucket)}/o/${esc(row.name)}`,
    mediaLink: `${base}/download/storage/v1/b/${esc(row.bucket)}/o/${esc(row.name)}?alt=media`,
  }
}
