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

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installS3Mock, S3MockStore, type S3Mock } from './mock.ts'

const enc = new TextEncoder()
const OLD = enc.encode('old\n')
const NEW = enc.encode('new\n')
const SRC = enc.encode('src\n')

function etag(data: Uint8Array): string {
  return `"${createHash('md5').update(data).digest('hex')}"`
}

describe('the S3 mount mock enforces conditions', () => {
  let mock: S3Mock
  let client: S3Client

  beforeEach(() => {
    const store = new S3MockStore()
    store.set('b', 'k', NEW)
    store.set('b', 'src', SRC)
    mock = installS3Mock(store)
    client = new S3Client({ region: 'us-east-1' })
  })

  afterEach(() => {
    mock.restore()
  })

  const put = (cond: Record<string, string>) =>
    client.send(
      new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: enc.encode('attempt\n'), ...cond }),
    )
  const copy = (cond: Record<string, string>) =>
    client.send(new CopyObjectCommand({ Bucket: 'b', Key: 'k', CopySource: 'b/src', ...cond }))
  const del = (cond: Record<string, string>) =>
    client.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k', ...cond }))

  // The fakes the conditional-write suite runs on must refuse a stale
  // condition the way AWS does (measured 2026-10-06), or every loss-side
  // test over them passes having checked nothing: moto ignores the copy
  // condition, which is the failure this table exists to rule out.
  it.each([
    ['put-if-match', () => put({ IfMatch: etag(OLD) })],
    ['put-if-none-match', () => put({ IfNoneMatch: '*' })],
    ['copy-if-match', () => copy({ IfMatch: etag(OLD) })],
    ['copy-if-none-match', () => copy({ IfNoneMatch: '*' })],
    ['delete-if-match', () => del({ IfMatch: etag(OLD) })],
  ])('refuses a stale condition and keeps the object: %s', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    })
    expect(mock.store.get('b', 'k')).toEqual(NEW)
  })

  it.each([
    ['put', () => put({ IfMatch: etag(OLD) })],
    ['copy', () => copy({ IfMatch: etag(OLD) })],
  ])('answers an If-Match on a missing key with not found: %s', async (_name, call) => {
    mock.store.delete('b', 'k')
    await expect(call()).rejects.toMatchObject({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    expect(mock.store.has('b', 'k')).toBe(false)
  })

  it('refuses a stale copy source and writes nothing', async () => {
    mock.store.delete('b', 'k')
    await expect(copy({ CopySourceIfMatch: etag(OLD) })).rejects.toMatchObject({
      name: 'PreconditionFailed',
    })
    expect(mock.store.has('b', 'k')).toBe(false)
  })

  it('reports a stale batch-delete key in the body and keeps it', async () => {
    mock.store.set('b', 'j', SRC)
    const resp = await client.send(
      new DeleteObjectsCommand({
        Bucket: 'b',
        Delete: {
          Objects: [
            { Key: 'k', ETag: etag(OLD) },
            { Key: 'j', ETag: etag(SRC) },
          ],
        },
      }),
    )
    // A refused key comes back in the body of a 200, which is what the
    // driver has to read.
    expect(resp.Errors?.map((e) => e.Key)).toEqual(['k'])
    expect(resp.Errors?.[0]?.Code).toBe('PreconditionFailed')
    expect(mock.store.has('b', 'k')).toBe(true)
    expect(mock.store.has('b', 'j')).toBe(false)
  })

  it.each([etag(NEW), etag(NEW).replace(/"/g, '')])(
    'applies a matching condition in either spelling: %s',
    async (spell) => {
      await put({ IfMatch: spell })
      expect(mock.store.get('b', 'k')).toEqual(enc.encode('attempt\n'))
    },
  )

  it('keeps the order and condition params of every request', async () => {
    await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }))
    await put({ IfMatch: etag(NEW) })
    expect(mock.ledger).toEqual([
      ['HeadObject', {}],
      ['PutObject', { IfMatch: etag(NEW) }],
    ])
  })

  it('judges a batch delete per key on the tripwire', async () => {
    // A marker first must not exempt an untagged file key behind it.
    mock.store.set('b', 'd/', new Uint8Array())
    mock.store.set('b', 'd/a', enc.encode('a'))
    mock.tripwire = true
    await expect(
      client.send(
        new DeleteObjectsCommand({
          Bucket: 'b',
          Delete: { Objects: [{ Key: 'd/' }, { Key: 'd/a' }] },
        }),
      ),
    ).rejects.toThrow(/unconditioned DeleteObjects of 'd\/a'/)
  })

  it('lands a hook between two requests', async () => {
    mock.before('PutObject', () => {
      mock.store.set('b', 'k', enc.encode('theirs\n'))
    })
    await expect(put({ IfMatch: etag(NEW) })).rejects.toMatchObject({ name: 'PreconditionFailed' })
    expect(mock.store.get('b', 'k')).toEqual(enc.encode('theirs\n'))
  })

  it('trips on an unconditioned mutation, except a directory marker', async () => {
    mock.tripwire = true
    await expect(put({})).rejects.toThrow('unconditioned PutObject')
    await client.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'dir/' }))
  })
})
