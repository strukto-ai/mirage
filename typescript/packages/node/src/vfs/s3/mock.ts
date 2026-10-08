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

import { mockClient, type AwsCommand } from 'aws-sdk-client-mock'
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  type __MetadataBearer as MetadataBearer,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

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

function preconditionFailed(): Error {
  const err: Error & { name: string; $metadata?: { httpStatusCode: number } } = new Error(
    'PreconditionFailed',
  )
  err.name = 'PreconditionFailed'
  err.$metadata = { httpStatusCode: 412 }
  return err
}

const CONDITION_KEYS = ['IfMatch', 'CopySourceIfMatch'] as const

export const MUTATIONS: ReadonlySet<string> = new Set([
  'PutObject',
  'CopyObject',
  'DeleteObject',
  'DeleteObjects',
])

type Conditions = Partial<Record<(typeof CONDITION_KEYS)[number], string>>

function bare(tag: string): string {
  return tag.replace(/^"|"$/g, '')
}

function sentOf(input: Conditions): Record<string, string> {
  const sent: Record<string, string> = {}
  for (const key of CONDITION_KEYS) {
    const value = input[key]
    if (value !== undefined) sent[key] = value
  }
  return sent
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
  /** How many times each command has been sent since the last reset. */
  calls: Map<string, number>
  reset(): void
  restore(): void
  // How many times one command has been sent, and a way to zero that count
  // without disturbing the stubbed behaviour (`reset` drops the handlers
  // too). A cost claim is asserted in HTTP verbs, which is what the python
  // twin counts through its own session. `input` narrows it, e.g. `{ Bucket }`.
  commandCalls<TInput extends object>(
    command: new (input: TInput) => AwsCommand<TInput, MetadataBearer>,
    input?: Partial<TInput>,
  ): number
  resetCalls(): void
  /** Every request in order with the condition parameters it sent. */
  ledger: [string, Record<string, string>][]
  /** Run `hook` once, just before the next `op` request lands. */
  before(op: string, hook: () => void | Promise<void>): void
  /** Drop every hook not yet run, so one a test left queued fires in no other. */
  clearHooks(): void
  /** Throw on a mutation sent without a condition, except a marker key. */
  tripwire: boolean
  /** Keys DeleteObjects refuses with AccessDenied in its body, as python's `undeletable`. */
  undeletable: Set<string>
  /** Rows per flat ListObjectsV2 page; null answers in one page, as python's `page_size`. */
  pageSize: number | null
}

/**
 * Options for {@link installS3Mock}.
 *
 * `etagSuffix` mirrors the python mock's `MultiBucketS3Client.etag_suffix`:
 * a non-empty value makes every ETag differ from md5(content), the way a
 * multipart or SSE-KMS upload's does, so a test can tell a real backend
 * token apart from a fabricated md5 of the content.
 */
export interface S3MockOptions {
  etagSuffix?: string
}

export function installS3Mock(
  store: S3MockStore = new S3MockStore(),
  options: S3MockOptions = {},
): S3Mock {
  const mock = mockClient(S3Client)
  const suffix = options.etagSuffix ?? ''
  const calls = new Map<string, number>()
  const count = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1)
  }
  const etag = (data: Uint8Array): string => `"${md5Hex(data)}${suffix}"`
  const ledger: [string, Record<string, string>][] = []
  const hooks = new Map<string, (() => void | Promise<void>)[]>()
  const state: { tripwire: boolean; pageSize: number | null } = { tripwire: false, pageSize: null }
  const undeletable = new Set<string>()
  const enter = async (op: string, key: string, sent: Record<string, string>): Promise<void> => {
    ledger.push([op, sent])
    const hook = hooks.get(op)?.shift()
    if (hook !== undefined) await hook()
    if (
      state.tripwire &&
      MUTATIONS.has(op) &&
      Object.keys(sent).length === 0 &&
      !key.endsWith('/')
    ) {
      throw new Error(`unconditioned ${op} of '${key}'`)
    }
  }
  // AWS answers an If-Match on a key that is gone with 404, not 412.
  const require = (current: Uint8Array | undefined, input: Conditions): void => {
    if (input.IfMatch !== undefined) {
      if (current === undefined) throw notFound()
      if (bare(input.IfMatch) !== bare(etag(current))) throw preconditionFailed()
    }
  }

  mock
    .on(GetObjectCommand)
    .callsFake(async (input: { Bucket: string; Key: string; Range?: string }) => {
      count('GetObject')
      await enter('GetObject', input.Key, {})
      const data = store.get(input.Bucket, input.Key)
      if (data === undefined) throw notFound()
      const sliced = sliceRange(data, input.Range)
      // From the whole object, never the slice: an ETag describes the object,
      // and real S3 (and the python mock) return it on GetObject too. Without
      // it a read stamps no token and the cache entry carries none.
      return Promise.resolve({
        Body: mockBody(sliced),
        ContentLength: sliced.byteLength,
        ETag: etag(data),
      })
    })

  mock.on(HeadObjectCommand).callsFake(async (input: { Bucket: string; Key: string }) => {
    count('HeadObject')
    await enter('HeadObject', input.Key, {})
    const data = store.get(input.Bucket, input.Key)
    if (data === undefined) throw notFound()
    return Promise.resolve({
      ContentLength: data.byteLength,
      LastModified: LAST_MODIFIED,
      ETag: etag(data),
    })
  })

  mock
    .on(ListObjectsV2Command)
    .callsFake(
      (input: {
        Bucket: string
        Prefix?: string
        Delimiter?: string
        ContinuationToken?: string
      }) => {
        const objects = store.objects(input.Bucket)
        const prefix = input.Prefix ?? ''
        const full =
          input.Delimiter === '/'
            ? paginateDirectory(objects, prefix)
            : paginateFlat(objects, prefix)
        // Real S3 continues after the last key it sent.
        const after = input.ContinuationToken
        const rows = (full.Contents ?? []).filter((c) => after === undefined || c.Key > after)
        const size = input.Delimiter === '/' ? null : state.pageSize
        const truncated = size !== null && rows.length > size
        const page = { ...full, Contents: truncated ? rows.slice(0, size) : rows }
        // Real S3 lists each object's ETag, which a conditional delete reads.
        return Promise.resolve({
          Contents: page.Contents.map((c) => {
            const data = objects.get(c.Key)
            return data === undefined ? c : { ...c, ETag: etag(data) }
          }),
          ...(page.CommonPrefixes !== undefined ? { CommonPrefixes: page.CommonPrefixes } : {}),
          IsTruncated: truncated,
          ...(truncated ? { NextContinuationToken: page.Contents.at(-1)?.Key ?? '' } : {}),
          KeyCount: page.Contents.length,
        })
      },
    )

  mock
    .on(PutObjectCommand)
    .callsFake(
      async (
        input: { Bucket: string; Key: string; Body: Uint8Array | string | undefined } & Conditions,
      ) => {
        let body: Uint8Array
        const raw = input.Body
        if (raw instanceof Uint8Array) body = raw
        else if (typeof raw === 'string') body = new TextEncoder().encode(raw)
        else body = new Uint8Array()
        count('PutObject')
        await enter('PutObject', input.Key, sentOf(input))
        require(store.get(input.Bucket, input.Key), input)
        store.set(input.Bucket, input.Key, body)
        return { ETag: etag(body) }
      },
    )

  mock
    .on(DeleteObjectCommand)
    .callsFake(async (input: { Bucket: string; Key: string } & Conditions) => {
      count('DeleteObject')
      await enter('DeleteObject', input.Key, sentOf(input))
      const current = store.get(input.Bucket, input.Key)
      if (current !== undefined)
        require(current, input.IfMatch !== undefined ? { IfMatch: input.IfMatch } : {})
      store.delete(input.Bucket, input.Key)
      return {}
    })

  mock
    .on(DeleteObjectsCommand)
    .callsFake(
      async (input: { Bucket: string; Delete: { Objects?: { Key: string; ETag?: string }[] } }) => {
        count('DeleteObjects')
        const listed = input.Delete.Objects ?? []
        // Judged per key: a marker never exempts an untagged file key.
        const untagged = listed.filter((o) => o.ETag === undefined && !o.Key.endsWith('/'))
        const tags = listed.filter((o) => o.ETag !== undefined).map((o) => String(o.ETag))
        const tagged = tags.length > 0 && untagged.length === 0 ? { ETag: tags.join(',') } : {}
        await enter('DeleteObjects', untagged[0]?.Key ?? listed[0]?.Key ?? '', tagged)
        const deleted: { Key: string }[] = []
        const errors: { Key: string; Code: string; Message: string }[] = []
        // A refused key comes back in the body of a 200, as real DeleteObjects does.
        for (const obj of listed) {
          const current = store.get(input.Bucket, obj.Key)
          if (
            obj.ETag !== undefined &&
            current !== undefined &&
            bare(obj.ETag) !== bare(etag(current))
          ) {
            errors.push({
              Key: obj.Key,
              Code: 'PreconditionFailed',
              Message: 'At least one of the pre-conditions you specified did not hold',
            })
            continue
          }
          if (undeletable.has(obj.Key)) {
            errors.push({ Key: obj.Key, Code: 'AccessDenied', Message: 'Access Denied' })
            continue
          }
          store.delete(input.Bucket, obj.Key)
          deleted.push({ Key: obj.Key })
        }
        return { Deleted: deleted, Errors: errors }
      },
    )

  mock
    .on(CopyObjectCommand)
    .callsFake(async (input: { Bucket: string; Key: string; CopySource: string } & Conditions) => {
      count('CopyObject')
      await enter('CopyObject', input.Key, sentOf(input))
      const source = lstripSlash(input.CopySource)
      const idx = source.indexOf('/')
      const srcBucket = idx > 0 ? source.slice(0, idx) : input.Bucket
      const srcKey = idx > 0 ? source.slice(idx + 1) : source
      const src = store.get(srcBucket, srcKey)
      if (
        src !== undefined &&
        input.CopySourceIfMatch !== undefined &&
        bare(input.CopySourceIfMatch) !== bare(etag(src))
      ) {
        throw preconditionFailed()
      }
      if (src !== undefined) require(store.get(input.Bucket, input.Key), input)
      store.copy(srcBucket, srcKey, input.Bucket, input.Key)
      return {
        CopyObjectResult: {
          ETag: etag(store.get(input.Bucket, input.Key) ?? new Uint8Array()),
        },
      }
    })

  return {
    store,
    calls,
    ledger,
    before: (op, hook) => {
      const queue = hooks.get(op) ?? []
      queue.push(hook)
      hooks.set(op, queue)
    },
    clearHooks: () => {
      hooks.clear()
    },
    undeletable,
    get pageSize() {
      return state.pageSize
    },
    set pageSize(value: number | null) {
      state.pageSize = value
    },
    get tripwire() {
      return state.tripwire
    },
    set tripwire(value: boolean) {
      state.tripwire = value
    },
    reset: () => {
      calls.clear()
      ledger.length = 0
      mock.reset()
    },
    restore: () => {
      mock.restore()
    },
    commandCalls: (command, input) => mock.commandCalls(command, input).length,
    resetCalls: () => {
      mock.resetHistory()
    },
  }
}
