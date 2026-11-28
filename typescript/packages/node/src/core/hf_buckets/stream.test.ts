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

import { recordingActive, recordingScope } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { HfHubError } from '@struktoai/mirage-core/core/hf_hub/client'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket } from '../../../tests/fixtures/hf_bucket.ts'
import { readStream } from './stream.ts'

const BIG = Buffer.from(`${'x'.repeat(1023)}\n`.repeat(300))

interface Mounted {
  accessor: HfBucketsAccessor
  bucket: HfBucket
}

let origin = ''
const buckets: HfBucket[] = []

beforeAll(async () => {
  origin = await serve('hf')
})

afterEach(async () => {
  await Promise.all(buckets.splice(0).map((bucket) => bucket.close()))
})

// An accessor on a bucket of its own after another client wrote `files` to
// it, the requests recorded from then on.
async function mounted(
  files: Record<string, string | Uint8Array>,
  keyPrefix?: string,
): Promise<Mounted> {
  const bucket = new HfBucket(origin)
  buckets.push(bucket)
  await bucket.reset()
  await bucket.put(files)
  await bucket.run.recordRequests()
  return { accessor: bucket.accessor(keyPrefix), bucket }
}

async function accessorWith(
  files: Record<string, string | Uint8Array>,
): Promise<HfBucketsAccessor> {
  return (await mounted(files)).accessor
}

async function drain(accessor: HfBucketsAccessor, path: string): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of readStream(accessor, PathSpec.fromStrPath(path))) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('hf stream', () => {
  it('streams a whole file', async () => {
    // The HTTP body arrives in whatever chunks the network hands over, so only
    // the joined bytes are the contract.
    const accessor = await accessorWith({ 'big.bin': 'a'.repeat(10000) })
    expect((await drain(accessor, '/big.bin')).toString()).toBe('a'.repeat(10000))
  })

  it('maps NotFound to ENOENT', async () => {
    const accessor = await accessorWith({})
    await expect(drain(accessor, '/missing')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is stamped before its first chunk', async () => {
    const { accessor, bucket } = await mounted({ 'big.bin': BIG })
    const row = await bucket.row('big.bin')
    await bucket.run.recordRequests()
    const [[chunks, first], records] = await recordingScope(async () => {
      const iter = readStream(accessor, PathSpec.fromStrPath('/big.bin'))[Symbol.asyncIterator]()
      return [iter, await iter.next()] as const
    })
    // Checked while the generator is suspended at its first yield: a consumer
    // that stops here (head -c) still leaves a record naming the bytes.
    expect(records.map((r) => r.fingerprint)).toEqual([row.xetHash])
    const parts: Uint8Array[] = first.done === true ? [] : [first.value]
    for (let next = await chunks.next(); next.done !== true; next = await chunks.next()) {
      parts.push(next.value)
    }
    expect(Buffer.concat(parts)).toEqual(BIG)
    expect(await bucket.count('opendal_read')).toBe(0)
  })

  it('stamps an empty stream too', async () => {
    const { accessor, bucket } = await mounted({ empty: '' })
    const row = await bucket.row('empty')
    const [data, records] = await recordingScope(() => drain(accessor, '/empty'))
    expect(data.byteLength).toBe(0)
    expect(records.map((r) => r.fingerprint)).toEqual([row.xetHash])
  })

  it('does not crash with no recorder bound', async () => {
    const accessor = await accessorWith({ x: 'abc' })
    expect(recordingActive()).toBe(false)
    expect((await drain(accessor, '/x')).toString()).toBe('abc')
  })

  it.each([['W/"abc"'], [null]])('stamps nothing without a strong etag (%s)', async (served) => {
    const { accessor, bucket } = await mounted({ x: 'abc' })
    await bucket.serveEtag('abc', served)
    const [, records] = await recordingScope(() => drain(accessor, '/x'))
    expect(records.map((r) => r.fingerprint ?? null)).toEqual([null])
  })

  it.each([
    [404, 'EntryNotFound', 'ENOENT'],
    [404, '', 'raw'],
    [401, '', 'EACCES'],
    [403, '', 'EACCES'],
    [400, '', 'raw'],
  ])('is absent only for a missing entry (%i %s)', async (status, code, want) => {
    const { accessor, bucket } = await mounted({ 'a.txt': 'abc' })
    await bucket.refuse('resolve', status, code)
    const err = await drain(accessor, '/a.txt').catch((e: unknown) => e)
    if (want === 'raw') {
      expect(err).toBeInstanceOf(HfHubError)
      expect((err as { code?: string }).code).toBeUndefined()
    } else {
      expect(err).toMatchObject({ code: want })
    }
  })

  it('answers the mount root as a directory', async () => {
    const { accessor, bucket } = await mounted({ pfx: 'stem', 'pfx/a.txt': 'a' }, 'pfx/')
    await expect(drain(accessor, '/')).rejects.toMatchObject({ code: 'EISDIR' })
    expect(await bucket.count('resolve')).toBe(0)
  })

  it('serves the prefixed object under a key prefix', async () => {
    const { accessor } = await mounted({ 'pfx/a.txt': 'seed', 'a.txt': 'decoy' }, 'pfx/')
    expect((await drain(accessor, '/a.txt')).toString()).toBe('seed')
  })
})
