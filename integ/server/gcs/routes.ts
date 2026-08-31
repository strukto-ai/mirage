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

import { rangeReply, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { DEFAULT_CONTENT_TYPE, DEFAULT_PROJECT, type C } from './config.ts'
import { boundaryOf, parseRelated } from './multipart.ts'
import {
  bucketIsEmpty,
  bucketOf,
  bucketsOf,
  deleteBucket,
  objectOf,
  objectsOf,
  putObject,
} from './store.ts'
import {
  bucketBody,
  bucketConflict,
  errorReply,
  mediaNotFound,
  notFound,
  objectBody,
  type ObjectRow,
} from './wire.ts'

// Every link the fake mints has to come back to the SAME run, so the base is
// the request's origin plus the `/_run/<id>` it arrived under. Dropping the
// prefix here sends a client following a mediaLink into the default run, where
// its object does not exist.
function base(ctx: Ctx<C>): string {
  return `${ctx.url.protocol}//${ctx.url.host}${ctx.runPrefix}`
}

function header(ctx: Ctx<C>, name: string): string {
  const raw = ctx.headers[name]
  const one = Array.isArray(raw) ? raw[0] : raw
  return one ?? ''
}

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function str(v: JsonValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

// ------------------------------------------------------------------ buckets

// `project` is read off the query and STORED, never filtered on. The real
// service scopes a listing to one project and fake-gcs-server, which this fake
// replaces, ignores the field entirely; filtering would be the more faithful of
// the two and is the more dangerous, because a creator and a lister that
// disagree about the project name answer an EMPTY listing rather than an error,
// and the seeder and the CLI take theirs from two different files.
async function listBuckets(ctx: Ctx<C>): Promise<Reply> {
  const rows = await bucketsOf(ctx.db, ctx.tenant, ctx.query.get('prefix') ?? '')
  return {
    status: 200,
    body: { kind: 'storage#buckets', items: rows.map((row) => bucketBody(row, base(ctx))) },
  }
}

async function createBucket(ctx: Ctx<C>): Promise<Reply> {
  const body = obj(ctx.json())
  const name = str(body.name, ctx.query.get('name') ?? '')
  if (name === '') return errorReply(400, 'Required parameter: name', 'required')
  if ((await bucketOf(ctx.db, ctx.tenant, name)) !== null) return bucketConflict(name)
  const now = ctx.clock.nowIso()
  const row = await ctx.db.gcsBucket.create({
    data: {
      tenant: ctx.tenant,
      name,
      project: ctx.query.get('project') ?? DEFAULT_PROJECT,
      timeCreated: now,
      updated: now,
      seq: await ctx.db.gcsBucket.count({ where: { tenant: ctx.tenant } }),
    },
  })
  return { status: 200, body: bucketBody(row, base(ctx)) }
}

async function getBucket(ctx: Ctx<C>): Promise<Reply> {
  const row = await bucketOf(ctx.db, ctx.tenant, ctx.params.bucket ?? '')
  if (row === null) return notFound()
  return { status: 200, body: bucketBody(row, base(ctx)) }
}

// 412, not the 409 the real service answers with. This is fake-gcs-server's
// code and wording, and it is what a caller that reads the status has been
// seeing; no consumer here reaches it at all, because the seeder empties the
// bucket first (`delete(force=True)` lists and deletes every object, then
// deletes the bucket).
async function removeBucket(ctx: Ctx<C>): Promise<Reply> {
  const name = ctx.params.bucket ?? ''
  if ((await bucketOf(ctx.db, ctx.tenant, name)) === null) return notFound()
  if (!(await bucketIsEmpty(ctx.db, ctx.tenant, name))) {
    return errorReply(412, 'bucket must be empty prior to deletion', 'conditionNotMet')
  }
  await deleteBucket(ctx.db, ctx.tenant, name)
  return { status: 204 }
}

// ------------------------------------------------------------------ objects

async function listObjects(ctx: Ctx<C>): Promise<Reply> {
  const bucket = ctx.params.bucket ?? ''
  if ((await bucketOf(ctx.db, ctx.tenant, bucket)) === null) return notFound()
  const rows = await objectsOf(ctx.db, ctx.tenant, bucket, ctx.query.get('prefix') ?? '')
  return {
    status: 200,
    body: { kind: 'storage#objects', items: rows.map((row) => objectBody(row, base(ctx))) },
  }
}

// One handler for three spellings of the same read, because they differ only in
// whether the bytes or the metadata are wanted: `?alt=media` under `/storage`,
// the same under `/download/storage` (which is what the python client's
// mediaLink resolves to), and no `alt` at all, which is the metadata.
async function getObject(ctx: Ctx<C>): Promise<Reply> {
  const media = ctx.query.get('alt') === 'media' || ctx.url.pathname.startsWith('/download/')
  const row = await objectOf(ctx.db, ctx.tenant, ctx.params.bucket ?? '', ctx.params.name ?? '')
  if (row === null) return media ? mediaNotFound() : notFound()
  if (!media) return { status: 200, body: objectBody(row, base(ctx)) }
  return rangeReply(ctx.headers, row.content, row.contentType)
}

async function removeObject(ctx: Ctx<C>): Promise<Reply> {
  const bucket = ctx.params.bucket ?? ''
  const name = ctx.params.name ?? ''
  if ((await objectOf(ctx.db, ctx.tenant, bucket, name)) === null) return notFound()
  await ctx.db.gcsObject.delete({
    where: { tenant_bucket_name: { tenant: ctx.tenant, bucket, name } },
  })
  return { status: 204 }
}

// ------------------------------------------------------------------- upload

async function stored(ctx: Ctx<C>, row: ObjectRow): Promise<Reply> {
  return { status: 200, body: objectBody(row, base(ctx)) }
}

// The three upload protocols, told apart by `uploadType` exactly as the vendor
// does. All three are reached in this stack and none is optional:
//   media      the CLI's `gcs upload`, and the bq proxy's header restore
//   multipart  the Go client the BigQuery emulator's extract job runs on
//   resumable  the python client's chunked writer, which the seeder uses
async function upload(ctx: Ctx<C>): Promise<Reply> {
  const bucket = ctx.params.bucket ?? ''
  if ((await bucketOf(ctx.db, ctx.tenant, bucket)) === null) return notFound()
  const kind = ctx.query.get('uploadType') ?? 'media'
  if (kind === 'resumable') return openResumable(ctx, bucket)
  if (kind === 'multipart') return uploadMultipart(ctx, bucket)
  const name = ctx.query.get('name') ?? ''
  if (name === '') return errorReply(400, 'Required parameter: name', 'required')
  const type = header(ctx, 'content-type')
  const row = await putObject(
    ctx.db,
    ctx.tenant,
    bucket,
    name,
    ctx.body,
    type === '' ? DEFAULT_CONTENT_TYPE : type,
    ctx.clock,
  )
  return stored(ctx, row)
}

async function uploadMultipart(ctx: Ctx<C>, bucket: string): Promise<Reply> {
  const boundary = boundaryOf(header(ctx, 'content-type'))
  if (boundary === null) return errorReply(400, 'missing multipart boundary', 'required')
  const parts = parseRelated(ctx.body, boundary)
  if (parts.length < 2) return errorReply(400, 'malformed multipart body', 'required')
  const meta = obj(JSON.parse(parts[0]?.body.toString('utf8') ?? '{}') as JsonValue)
  const media = parts[1]
  const name = str(meta.name, ctx.query.get('name') ?? '')
  if (name === '' || media === undefined) {
    return errorReply(400, 'Required parameter: name', 'required')
  }
  const declared = str(meta.contentType, media.contentType)
  const row = await putObject(
    ctx.db,
    ctx.tenant,
    bucket,
    name,
    media.body,
    declared === '' ? DEFAULT_CONTENT_TYPE : declared,
    ctx.clock,
  )
  return stored(ctx, row)
}

// The session URI goes back on `Location`, and it has to be one this fake
// routes: the client PUTs to it verbatim. It carries the run prefix for the
// same reason every other minted link does.
async function openResumable(ctx: Ctx<C>, bucket: string): Promise<Reply> {
  const meta = obj(
    ctx.body.length === 0 ? {} : (JSON.parse(ctx.body.toString('utf8')) as JsonValue),
  )
  const name = str(meta.name, ctx.query.get('name') ?? '')
  if (name === '') return errorReply(400, 'Required parameter: name', 'required')
  const declared = header(ctx, 'x-upload-content-type') || str(meta.contentType)
  const id = String(ctx.minter.next('upload')).padStart(32, '0')
  await ctx.db.gcsUpload.create({
    data: {
      tenant: ctx.tenant,
      id,
      bucket,
      name,
      contentType: declared === '' ? DEFAULT_CONTENT_TYPE : declared,
      content: Buffer.alloc(0),
      seq: await ctx.db.gcsUpload.count({ where: { tenant: ctx.tenant } }),
    },
  })
  const query = new URLSearchParams({ uploadType: 'resumable', name, upload_id: id })
  return {
    status: 200,
    headers: {
      Location: `${base(ctx)}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${query.toString()}`,
    },
    body: objectBody(
      {
        bucket,
        name,
        content: Buffer.alloc(0),
        contentType: declared === '' ? DEFAULT_CONTENT_TYPE : declared,
        timeCreated: ctx.clock.nowIso(),
        updated: ctx.clock.nowIso(),
        generation: '0',
      },
      base(ctx),
    ),
  }
}

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/

// One chunk of a resumable upload. A chunk whose Content-Range ends in `/*` is
// not the last one, and the answer to it is 308 with the bytes accepted so far
// -- NOT a 200 with an object, which would make the client stop early and store
// a truncated file. A request with no Content-Range at all is a single-shot
// upload of the whole body, which is what a small `blob.upload_from_file` sends.
async function resumableChunk(ctx: Ctx<C>): Promise<Reply> {
  const id = ctx.query.get('upload_id') ?? ''
  const session = await ctx.db.gcsUpload.findUnique({
    where: { tenant_id: { tenant: ctx.tenant, id } },
  })
  if (session === null) return notFound()
  const held = Buffer.from(session.content)
  // A client that lost a response asks where the upload stands with an empty
  // PUT whose Content-Range is `bytes */*` (or `bytes */<total>`). That is a
  // question, not a chunk: answer 308 with the accepted range and touch
  // nothing, because reading it as a range-less final chunk stored the
  // partial bytes as the completed object.
  if (/^bytes \*\/(\d+|\*)$/.test(header(ctx, 'content-range'))) {
    return {
      status: 308,
      headers: held.length === 0 ? {} : { Range: `bytes=0-${String(held.length - 1)}` },
      body: Buffer.alloc(0),
    }
  }
  const range = CONTENT_RANGE_RE.exec(header(ctx, 'content-range'))
  // A chunk is final only when its declared END reaches the last byte of a
  // declared total. A client that knows the size up front sends the number on
  // EVERY chunk (`bytes 0-9/100` is the first tenth, not the whole thing), so
  // a numeric denominator alone finalized ten bytes as the object and 404'd
  // the rest of the upload.
  const more = range !== null && (range[3] === '*' || Number(range[2]) < Number(range[3]) - 1)
  // A chunk is PLACED at the offset its Content-Range declares, never
  // appended blind: a client that lost a 308 retransmits from an earlier
  // offset, and concatenation would store those bytes twice. A chunk
  // starting beyond what is held is a gap, answered as 308 with the
  // progress so far, exactly as if it had not arrived.
  let merged: Buffer<ArrayBuffer>
  if (range === null) {
    merged = Buffer.concat([held, ctx.body])
  } else {
    const start = Number(range[1])
    if (start > held.length) {
      return {
        status: 308,
        headers: held.length === 0 ? {} : { Range: `bytes=0-${String(held.length - 1)}` },
        body: Buffer.alloc(0),
      }
    }
    merged = Buffer.concat([held, ctx.body.subarray(held.length - start)])
  }
  if (more) {
    await ctx.db.gcsUpload.update({
      where: { tenant_id: { tenant: ctx.tenant, id } },
      data: { content: merged },
    })
    return {
      status: 308,
      headers: { Range: `bytes=0-${String(merged.length - 1)}` },
      body: Buffer.alloc(0),
    }
  }
  await ctx.db.gcsUpload.delete({ where: { tenant_id: { tenant: ctx.tenant, id } } })
  const row = await putObject(
    ctx.db,
    ctx.tenant,
    session.bucket,
    session.name,
    merged,
    session.contentType,
    ctx.clock,
  )
  return stored(ctx, row)
}

// A name is a PATH, so every object route takes it as a wildcard. The clients
// here escape it whole (`out-*.csv` arrives as `out-%2A.csv`), but a caller
// that leaves the slashes in is spelling the same object and must reach it.
export function gcsRoutes(): KitRoute<C>[] {
  return [
    route('GET', '/storage/v1/b', listBuckets),
    route('POST', '/storage/v1/b', createBucket, { write: true }),
    route('GET', '/storage/v1/b/:bucket', getBucket),
    route('DELETE', '/storage/v1/b/:bucket', removeBucket, { write: true }),
    route('GET', '/storage/v1/b/:bucket/o', listObjects),
    route('GET', '/storage/v1/b/:bucket/o/*name', getObject),
    route('DELETE', '/storage/v1/b/:bucket/o/*name', removeObject, { write: true }),
    route('GET', '/download/storage/v1/b/:bucket/o/*name', getObject),
    route('POST', '/upload/storage/v1/b/:bucket/o', upload, { write: true }),
    route('PUT', '/upload/storage/v1/b/:bucket/o', resumableChunk, { write: true }),
  ]
}
