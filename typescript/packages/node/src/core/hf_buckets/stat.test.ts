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

import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { HfHubError } from '@struktoai/mirage-core/core/hf_hub/client'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket, PATHS_INFO } from '../../../tests/fixtures/hf_bucket.ts'
import { DRIVER, type HfConn } from './driver.ts'
import { stat } from './stat.ts'

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
async function mounted(files: Record<string, string>, keyPrefix?: string): Promise<Mounted> {
  const bucket = new HfBucket(origin)
  buckets.push(bucket)
  await bucket.reset()
  await bucket.put(files)
  await bucket.run.recordRequests()
  return { accessor: bucket.accessor(keyPrefix), bucket }
}

async function accessorWith(files: Record<string, string>): Promise<HfBucketsAccessor> {
  return (await mounted(files)).accessor
}

describe('hf stat', () => {
  it('returns a directory stat for root', async () => {
    const accessor = await accessorWith({})
    const s = await stat(accessor, PathSpec.fromStrPath('/'))
    expect(s.name).toBe('/')
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('stamps the paths-info xet hash on a file', async () => {
    const { accessor, bucket } = await mounted({ 'config.json': '{"a":1}' })
    const row = await bucket.row('config.json')
    await bucket.run.recordRequests()
    const s = await stat(accessor, PathSpec.fromStrPath('/config.json'))
    expect(s.name).toBe('config.json')
    expect(s.size).toBe(7)
    // The same value the download's ETag carries, so a read can match it
    // (measured 2026-09-25); opendal reports no token for a bucket.
    expect(s.fingerprint).toBe(row.xetHash)
    expect(s.extra).toEqual({ etag: row.xetHash })
    // The row carries uploadedAt, and stat still reports no mtime, as it does
    // against the live Hub today.
    expect(s.modified ?? null).toBeNull()
    expect([
      await bucket.count('paths_info'),
      await bucket.count('stat'),
      await bucket.count('opendal_read'),
    ]).toEqual([1, 0, 0])
  })

  it('stats a directory through the listing probe', async () => {
    const { accessor, bucket } = await mounted({ 'onnx/model.onnx': 'x' })
    const s = await stat(accessor, PathSpec.fromStrPath('/onnx'))
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('onnx')
    // paths-info answers [] for a directory; the listing probe decides.
    expect(await bucket.count('stat')).toBe(0)
  })

  it('raises ENOENT for missing paths', async () => {
    const accessor = await accessorWith({ 'a.txt': 'x' })
    await expect(stat(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  // paths-info never 404s for a missing path (it answers []), so every
  // refusal here is about the bucket. An anonymous caller asking for a bucket
  // that does not exist gets 401 (measured 2026-09-25); a 404 with a valid
  // token was not measured and is mapped the same conservative way.
  it.each([
    [401, ''],
    [403, ''],
    [404, 'RepoNotFound'],
  ])('answers a refused bucket (%i %s) as permission denied', async (status, code) => {
    const { accessor, bucket } = await mounted({ 'a.txt': 'x' })
    await bucket.refuse('paths_info', status, code)
    await expect(stat(accessor, PathSpec.fromStrPath('/a.txt'))).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('keeps a hub fault a hub error', async () => {
    // 400 rather than a 5xx, which the client retries with backoff.
    const { accessor, bucket } = await mounted({ 'a.txt': 'x' })
    await bucket.refuse('paths_info', 400)
    const err = await stat(accessor, PathSpec.fromStrPath('/a.txt')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HfHubError)
  })

  it('reads the prefixed object under a key prefix', async () => {
    const { accessor, bucket } = await mounted({ 'pfx/a.txt': 'seed', 'a.txt': 'decoy' }, '/pfx/')
    const s = await stat(accessor, PathSpec.fromStrPath('/a.txt'))
    expect(s.fingerprint).toBe((await bucket.row('pfx/a.txt')).xetHash)
    expect(s.fingerprint).not.toBe((await bucket.row('a.txt')).xetHash)
  })
})

describe('hf head', () => {
  it('returns meta for a file and null otherwise', async () => {
    const { accessor, bucket } = await mounted({ 'a.txt': '12345', 'd/x.txt': 'x' })
    const row = await bucket.row('a.txt')
    await bucket.run.recordRequests()
    const conn: HfConn = { accessor, op: await accessor.operator() }
    const meta = await DRIVER.head(conn, 'a.txt')
    expect(meta).not.toBeNull()
    expect([meta?.size, meta?.fingerprint]).toEqual([5, row.xetHash])
    expect(meta?.extra).toEqual({ etag: row.xetHash })
    expect(meta?.modified ?? null).toBeNull()
    expect(await DRIVER.head(conn, 'missing.txt')).toBeNull()
    expect(await DRIVER.head(conn, 'd')).toBeNull()
    expect(await bucket.count('stat')).toBe(0)
  })

  it('stamps nothing for a row without a hash', async () => {
    const { accessor, bucket } = await mounted({ 'a.txt': '12345' })
    await bucket.run.answerNext('POST', PATHS_INFO, 200, [{ type: 'file', path: 'a.txt', size: 5 }])
    const conn: HfConn = { accessor, op: await accessor.operator() }
    const meta = await DRIVER.head(conn, 'a.txt')
    expect(meta).not.toBeNull()
    expect([meta?.fingerprint ?? null, meta?.extra]).toEqual([null, {}])
  })

  it('refuses a row without a size', async () => {
    // A zero it made up would be a confident wrong size on a mount that
    // declares every size known.
    const { accessor, bucket } = await mounted({ 'a.txt': '12345' })
    await bucket.run.answerNext('POST', PATHS_INFO, 200, [
      { type: 'file', path: 'a.txt', xetHash: 'h' },
    ])
    const conn: HfConn = { accessor, op: await accessor.operator() }
    await expect(DRIVER.head(conn, 'a.txt')).rejects.toBeInstanceOf(HfHubError)
  })
})
