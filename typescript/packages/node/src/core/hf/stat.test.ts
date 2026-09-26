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

import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfHubError } from '../hf_hub/client.ts'
import { type FakeHub, xetHash } from '../hf_hub/_test_util.ts'
import { DRIVER, type HfConn } from './driver.ts'
import { type FakeHfOperator, fakeHfOperator, installFakeOperator } from './mock.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

interface Mounted {
  accessor: HfBucketsAccessor
  fake: FakeHfOperator
  hub: FakeHub
}

async function mounted(
  files: Record<string, string | Buffer>,
  keyPrefix?: string,
): Promise<Mounted> {
  const accessor = new HfBucketsAccessor(
    keyPrefix === undefined ? { bucket: 'ns/model' } : { bucket: 'ns/model', keyPrefix },
  )
  const fake = fakeHfOperator(files)
  const hub = await installFakeOperator(accessor, fake)
  return { accessor, fake, hub }
}

async function accessorWith(files: Record<string, string | Buffer>): Promise<HfBucketsAccessor> {
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
    const { accessor, fake, hub } = await mounted({ 'config.json': '{"a":1}' })
    fake.reach = []
    const s = await stat(accessor, PathSpec.fromStrPath('/config.json'))
    expect(s.name).toBe('config.json')
    expect(s.size).toBe(7)
    // The same value the download's ETag carries, so a read can match it
    // (measured 2026-09-25); opendal reports no token for a bucket.
    expect(s.fingerprint).toBe(xetHash(Buffer.from('{"a":1}')))
    expect(s.extra).toEqual({ etag: xetHash(Buffer.from('{"a":1}')) })
    // The row carries uploadedAt, and stat still reports no mtime, as it does
    // against the live Hub today.
    expect(s.modified ?? null).toBeNull()
    expect(hub.count('bucket_paths_info')).toBe(1)
    expect([fake.statCalls, fake.reach]).toEqual([0, []])
  })

  it('stats a directory through the listing probe', async () => {
    const { accessor, fake } = await mounted({ 'onnx/model.onnx': 'x' })
    const s = await stat(accessor, PathSpec.fromStrPath('/onnx'))
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.name).toBe('onnx')
    // paths-info answers [] for a directory; the listing probe decides.
    expect(fake.statCalls).toBe(0)
  })

  it('raises ENOENT for missing paths', async () => {
    const accessor = await accessorWith({ 'a.txt': 'x' })
    await expect(stat(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('serves stats from the index cache after readdir without network calls', async () => {
    const accessor = await accessorWith({ 'a.txt': 'abc', 'dir/b.txt': 'x' })
    const index = new RAMIndexCacheStore()
    await readdir(accessor, PathSpec.fromStrPath('/'), index)
    const fake = fakeHfOperator({})
    await installFakeOperator(accessor, fake)
    const file = await stat(accessor, PathSpec.fromStrPath('/a.txt'), index)
    expect(file.size).toBe(3)
    const dir = await stat(accessor, PathSpec.fromStrPath('/dir'), index)
    expect(dir.type).toBe(FileType.DIRECTORY)
    await expect(stat(accessor, PathSpec.fromStrPath('/missing'), index)).rejects.toMatchObject({
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
    const { accessor, hub } = await mounted({ 'a.txt': 'x' })
    hub.fail.set('bucket_paths_info', [status, code])
    await expect(stat(accessor, PathSpec.fromStrPath('/a.txt'))).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  it('keeps a hub fault a hub error', async () => {
    // 400 rather than a 5xx, which the client retries with backoff.
    const { accessor, hub } = await mounted({ 'a.txt': 'x' })
    hub.fail.set('bucket_paths_info', [400, ''])
    const err = await stat(accessor, PathSpec.fromStrPath('/a.txt')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HfHubError)
  })

  it('reads the prefixed object under a key prefix', async () => {
    const { accessor } = await mounted({ 'pfx/a.txt': 'seed', 'a.txt': 'decoy' }, '/pfx/')
    const s = await stat(accessor, PathSpec.fromStrPath('/a.txt'))
    expect(s.fingerprint).toBe(xetHash(Buffer.from('seed')))
  })
})

describe('hf head', () => {
  it('returns meta for a file and null otherwise', async () => {
    const { accessor, fake } = await mounted({ 'a.txt': '12345', 'd/x.txt': 'x' })
    const conn: HfConn = { accessor, op: await accessor.operator() }
    const meta = await DRIVER.head(conn, 'a.txt')
    expect(meta).not.toBeNull()
    expect([meta?.size, meta?.fingerprint]).toEqual([5, xetHash(Buffer.from('12345'))])
    expect(meta?.extra).toEqual({ etag: xetHash(Buffer.from('12345')) })
    expect(meta?.modified ?? null).toBeNull()
    expect(await DRIVER.head(conn, 'missing.txt')).toBeNull()
    expect(await DRIVER.head(conn, 'd')).toBeNull()
    expect(fake.statCalls).toBe(0)
  })

  it('stamps nothing for a row without a hash', async () => {
    const { accessor, hub } = await mounted({ 'a.txt': '12345' })
    hub.bucketAnswer = [{ type: 'file', path: 'a.txt', size: 5 }]
    const conn: HfConn = { accessor, op: await accessor.operator() }
    const meta = await DRIVER.head(conn, 'a.txt')
    expect(meta).not.toBeNull()
    expect([meta?.fingerprint ?? null, meta?.extra]).toEqual([null, {}])
  })

  it('refuses a row without a size', async () => {
    // A zero it made up would be a confident wrong size on a mount that
    // declares every size known.
    const { accessor, hub } = await mounted({ 'a.txt': '12345' })
    hub.bucketAnswer = [{ type: 'file', path: 'a.txt', xetHash: 'h' }]
    const conn: HfConn = { accessor, op: await accessor.operator() }
    await expect(DRIVER.head(conn, 'a.txt')).rejects.toBeInstanceOf(HfHubError)
  })
})
