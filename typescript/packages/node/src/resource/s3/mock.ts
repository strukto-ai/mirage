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

import { mockClient } from 'aws-sdk-client-mock'
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { compareCodePoints, lstripSlash } from '@struktoai/mirage-core'

const LAST_MODIFIED = new Date('2026-03-31T00:00:00Z')

export class S3MockStore {
  private readonly buckets = new Map<string, Map<string, Uint8Array>>()

  objects(bucket: string): Map<string, Uint8Array> {
    let m = this.buckets.get(bucket)
    if (m === undefined) {
      m = new Map()
      this.buckets.set(bucket, m)
    }
    return m
  }

  set(bucket: string, key: string, data: Uint8Array): void {
    this.objects(bucket).set(key, data)
  }

  get(bucket: string, key: string): Uint8Array | undefined {
    return this.buckets.get(bucket)?.get(key)
  }

  has(bucket: string, key: string): boolean {
    return this.buckets.get(bucket)?.has(key) ?? false
  }

  delete(bucket: string, key: string): void {
    this.buckets.get(bucket)?.delete(key)
  }

  copy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): void {
    const data = this.get(srcBucket, srcKey)
    if (data !== undefined) this.set(dstBucket, dstKey, data)
  }

  allBuckets(): readonly string[] {
    return [...this.buckets.keys()]
  }
}

function notFound(): Error {
  const err: Error & { name: string; $metadata?: { httpStatusCode: number } } = new Error(
    'NoSuchKey',
  )
  err.name = 'NoSuchKey'
  err.$metadata = { httpStatusCode: 404 }
  return err
}

function invalidRange(): Error {
  const err: Error & { name: string; $metadata?: { httpStatusCode: number } } = new Error(
    'InvalidRange',
  )
  err.name = 'InvalidRange'
  err.$metadata = { httpStatusCode: 416 }
  return err
}

/**
 * The slice a real ranged GET would return, refusals included.
 *
 * S3 answers 416 for a window starting at or past the end of a non-empty
 * object. The mock used to slice regardless and hand back an empty array —
 * which is the answer the ops layer produces only *after* normalizing that
 * refusal, so agreeing with the fixed code for free left the normalization
 * untested.
 */
function sliceRange(data: Uint8Array, rangeSpec: string | undefined): Uint8Array {
  if (!rangeSpec?.startsWith('bytes=')) return data
  const bounds = rangeSpec.slice(6).split('-', 2)
  const start = bounds[0] ? Number.parseInt(bounds[0], 10) : 0
  const end = bounds[1] ? Number.parseInt(bounds[1], 10) : data.byteLength - 1
  if (data.byteLength > 0 && start >= data.byteLength) throw invalidRange()
  return data.slice(start, end + 1)
}

interface PaginateResult {
  Contents?: { Key: string; Size: number }[]
  CommonPrefixes?: { Prefix: string }[]
}

function paginateDirectory(objects: Map<string, Uint8Array>, prefix: string): PaginateResult {
  const commonPrefixes = new Set<string>()
  const contents: { Key: string; Size: number }[] = []
  const sorted = [...objects.entries()].sort(([a], [b]) => compareCodePoints(a, b))
  for (const [key, data] of sorted) {
    if (!key.startsWith(prefix)) continue
    const relative = key.slice(prefix.length)
    if (relative === '') {
      contents.push({ Key: key, Size: data.byteLength })
      continue
    }
    if (relative.includes('/')) {
      const child = relative.split('/', 1)[0]
      commonPrefixes.add(prefix + String(child) + '/')
      continue
    }
    contents.push({ Key: key, Size: data.byteLength })
  }
  return {
    CommonPrefixes: [...commonPrefixes].sort(compareCodePoints).map((p) => ({ Prefix: p })),
    Contents: contents,
  }
}

function paginateFlat(objects: Map<string, Uint8Array>, prefix: string): PaginateResult {
  const contents: { Key: string; Size: number }[] = []
  const sorted = [...objects.entries()].sort(([a], [b]) => compareCodePoints(a, b))
  for (const [key, data] of sorted) {
    if (key.startsWith(prefix)) contents.push({ Key: key, Size: data.byteLength })
  }
  return { Contents: contents }
}

function md5Hex(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex')
}

interface MockBody {
  transformToByteArray(): Promise<Uint8Array>
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
}

function mockBody(data: Uint8Array): MockBody {
  return {
    transformToByteArray: () => Promise.resolve(data),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      const chunkSize = 8192
      for (let i = 0; i < data.byteLength; i += chunkSize) {
        yield data.slice(i, Math.min(i + chunkSize, data.byteLength))
      }
    },
  }
}

export interface S3Mock {
  store: S3MockStore
  reset(): void
  restore(): void
}

export function installS3Mock(store: S3MockStore = new S3MockStore()): S3Mock {
  const mock = mockClient(S3Client)

  mock.on(GetObjectCommand).callsFake((input: { Bucket: string; Key: string; Range?: string }) => {
    const data = store.get(input.Bucket, input.Key)
    if (data === undefined) throw notFound()
    const sliced = sliceRange(data, input.Range)
    return Promise.resolve({ Body: mockBody(sliced), ContentLength: sliced.byteLength })
  })

  mock.on(HeadObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
    const data = store.get(input.Bucket, input.Key)
    if (data === undefined) throw notFound()
    return Promise.resolve({
      ContentLength: data.byteLength,
      LastModified: LAST_MODIFIED,
      ETag: `"${md5Hex(data)}"`,
    })
  })

  mock
    .on(ListObjectsV2Command)
    .callsFake((input: { Bucket: string; Prefix?: string; Delimiter?: string }) => {
      const objects = store.objects(input.Bucket)
      const prefix = input.Prefix ?? ''
      const page =
        input.Delimiter === '/' ? paginateDirectory(objects, prefix) : paginateFlat(objects, prefix)
      return Promise.resolve({
        Contents: page.Contents ?? [],
        ...(page.CommonPrefixes !== undefined ? { CommonPrefixes: page.CommonPrefixes } : {}),
        IsTruncated: false,
        KeyCount: page.Contents?.length ?? 0,
      })
    })

  mock
    .on(PutObjectCommand)
    .callsFake((input: { Bucket: string; Key: string; Body: Uint8Array | string | undefined }) => {
      let body: Uint8Array
      const raw = input.Body
      if (raw instanceof Uint8Array) body = raw
      else if (typeof raw === 'string') body = new TextEncoder().encode(raw)
      else body = new Uint8Array()
      store.set(input.Bucket, input.Key, body)
      return Promise.resolve({ ETag: `"${md5Hex(body)}"` })
    })

  mock.on(DeleteObjectCommand).callsFake((input: { Bucket: string; Key: string }) => {
    store.delete(input.Bucket, input.Key)
    return Promise.resolve({})
  })

  mock
    .on(DeleteObjectsCommand)
    .callsFake((input: { Bucket: string; Delete: { Objects?: { Key: string }[] } }) => {
      const deleted: { Key: string }[] = []
      for (const obj of input.Delete.Objects ?? []) {
        store.delete(input.Bucket, obj.Key)
        deleted.push({ Key: obj.Key })
      }
      return Promise.resolve({ Deleted: deleted })
    })

  mock
    .on(CopyObjectCommand)
    .callsFake((input: { Bucket: string; Key: string; CopySource: string }) => {
      const source = lstripSlash(input.CopySource)
      const idx = source.indexOf('/')
      const srcBucket = idx > 0 ? source.slice(0, idx) : input.Bucket
      const srcKey = idx > 0 ? source.slice(idx + 1) : source
      store.copy(srcBucket, srcKey, input.Bucket, input.Key)
      return Promise.resolve({
        CopyObjectResult: {
          ETag: `"${md5Hex(store.get(input.Bucket, input.Key) ?? new Uint8Array())}"`,
        },
      })
    })

  return {
    store,
    reset: () => {
      mock.reset()
    },
    restore: () => {
      mock.restore()
    },
  }
}
