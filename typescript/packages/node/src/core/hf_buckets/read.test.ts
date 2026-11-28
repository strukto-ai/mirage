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

import { recordingScope } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { HfHubError } from '@struktoai/mirage-core/core/hf_hub/client'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { CDN, HfBucket } from '../../../tests/fixtures/hf_bucket.ts'
import { read } from './read.ts'

const SEED = Buffer.from('name,age\nalice,30\n')

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

async function stamped(
  accessor: HfBucketsAccessor,
  path: string,
  options: { offset?: number; size?: number } = {},
): Promise<[Uint8Array, (string | null)[]]> {
  const [data, records] = await recordingScope(() =>
    read(accessor, PathSpec.fromStrPath(path), options),
  )
  return [data, records.map((r) => r.fingerprint ?? null)]
}

describe('hf read', () => {
  it('reads a file', async () => {
    const accessor = await accessorWith({ 'a.csv': SEED })
    const data = await read(accessor, PathSpec.fromStrPath('/a.csv'))
    expect(Buffer.from(data).equals(SEED)).toBe(true)
  })

  it('reads full file bytes', async () => {
    const accessor = await accessorWith({ 'config.json': '{"a":1}' })
    const data = await read(accessor, PathSpec.fromStrPath('/config.json'))
    expect(Buffer.from(data).toString()).toBe('{"a":1}')
  })

  it('strips the mount prefix from the key', async () => {
    const accessor = await accessorWith({ 'sub/file.txt': 'hello' })
    const data = await read(
      accessor,
      PathSpec.fromStrPath('/m/sub/file.txt', mountKey('/m/sub/file.txt', '/m')),
    )
    expect(Buffer.from(data).toString()).toBe('hello')
  })

  it('honors offset and size', async () => {
    const accessor = await accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await read(accessor, PathSpec.fromStrPath('/f.bin'), {
      offset: 2,
      size: 3,
    })
    expect(Buffer.from(data).toString()).toBe('cde')
  })

  it('honors size without offset', async () => {
    const accessor = await accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await read(accessor, PathSpec.fromStrPath('/f.bin'), { size: 4 })
    expect(Buffer.from(data).toString()).toBe('abcd')
  })

  it('maps NotFound to ENOENT', async () => {
    const accessor = await accessorWith({})
    await expect(read(accessor, PathSpec.fromStrPath('/missing.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it.each([
    [{}, SEED],
    [{ offset: 5, size: 3 }, SEED.subarray(5, 8)],
  ])('stamps the download etag (window %o)', async (window, expected) => {
    const { accessor, bucket } = await mounted({ 'a.txt': SEED })
    const row = await bucket.row('a.txt')
    await bucket.run.recordRequests()
    const [data, stamps] = await stamped(accessor, '/a.txt', window)
    expect(Buffer.from(data)).toEqual(Buffer.from(expected))
    // The strong ETag the bytes came with is the xet hash stat reports, for a
    // ranged 206 as for a whole read (measured 2026-09-25).
    expect(stamps).toEqual([row.xetHash])
    expect([
      await bucket.count('resolve'),
      await bucket.count('paths_info'),
      await bucket.count('opendal_read'),
    ]).toEqual([1, 0, 0])
  })

  it.each([
    ['"other"', 'other'],
    ['weak', null],
    ['""', null],
    [null, null],
  ])('stamps only the response own strong etag (%s)', async (served, stamp) => {
    // "other" proves the token rides the read itself rather than a second
    // request; a weak validator does not vouch for bytes, and an empty or
    // missing one stamps nothing rather than "".
    const { accessor, bucket } = await mounted({ 'a.txt': SEED })
    const etag = served === 'weak' ? `W/"${(await bucket.row('a.txt')).xetHash}"` : served
    await bucket.serveEtag(SEED, etag)
    const [, stamps] = await stamped(accessor, '/a.txt')
    expect(stamps).toEqual([stamp])
  })

  it.each([
    [404, 'EntryNotFound', 'ENOENT'],
    [404, '', 'raw'],
    [401, '', 'EACCES'],
    [403, '', 'EACCES'],
    [400, '', 'raw'],
  ])('is absent only for a missing entry (%i %s)', async (status, code, want) => {
    // A 404 without EntryNotFound (a CDN or bucket-level one) must not read as
    // a deleted file: reconcile would drop the overlay for it.
    const { accessor, bucket } = await mounted({ 'a.txt': SEED })
    await bucket.refuse('resolve', status, code)
    const err = await read(accessor, PathSpec.fromStrPath('/a.txt')).catch((e: unknown) => e)
    if (want === 'raw') {
      expect(err).toBeInstanceOf(HfHubError)
      expect((err as { code?: string }).code).toBeUndefined()
    } else {
      expect(err).toMatchObject({ code: want })
    }
  })

  it('answers the mount root as a directory even under a prefix', async () => {
    // The prefix stem is itself a readable file; a read of the mount root must
    // not serve it.
    const { accessor, bucket } = await mounted({ pfx: 'stem', 'pfx/a.txt': SEED }, 'pfx/')
    await expect(read(accessor, PathSpec.fromStrPath('/'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(await bucket.count('resolve')).toBe(0)
  })

  it('reads a directory key directly as absent', async () => {
    // resolve on a directory key answers 404 EntryNotFound (measured 2026-09-25).
    const accessor = await accessorWith({ 'd/x.txt': 'x' })
    await expect(read(accessor, PathSpec.fromStrPath('/d'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reads a window past EOF as empty and stamps nothing', async () => {
    const { accessor, bucket } = await mounted({ 'a.txt': 'abc' })
    await bucket.run.recordRequests('range')
    const [data, stamps] = await stamped(accessor, '/a.txt', { offset: 99, size: 5 })
    expect([data.byteLength, stamps]).toEqual([0, [null]])
    // The Hub answers 416 here (measured 2026-09-25); the fold is the read's
    // own, since a caller reading the range directly has no other.
    expect(await bucket.run.headers('GET', CDN)).toEqual([{ range: 'bytes=99-103' }])
    const [short] = await stamped(accessor, '/a.txt', { offset: 0, size: 100 })
    expect(Buffer.from(short).toString()).toBe('abc')
  })

  it('answers a zero-length window empty but still checks the file', async () => {
    // The table's range read reaches here with no factory short-circuit, and a
    // zero-length Range header is not one the client can build; the read still
    // has to say whether the file is there, as opendal's open did.
    const { accessor, bucket } = await mounted({ 'a.txt': 'abc' })
    const data = await read(accessor, PathSpec.fromStrPath('/a.txt'), {
      offset: 1,
      size: 0,
    })
    expect([data.byteLength, await bucket.count('resolve')]).toEqual([0, 1])
    await expect(
      read(accessor, PathSpec.fromStrPath('/missing.txt'), { offset: 0, size: 0 }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serves the prefixed object under a key prefix', async () => {
    const { accessor, bucket } = await mounted({ 'pfx/a.txt': SEED, 'a.txt': 'decoy' }, 'pfx/')
    expect(Buffer.from(await read(accessor, PathSpec.fromStrPath('/a.txt')))).toEqual(SEED)
    const window = await read(accessor, PathSpec.fromStrPath('/a.txt'), {
      offset: 5,
      size: 3,
    })
    expect(Buffer.from(window)).toEqual(SEED.subarray(5, 8))
    // A write through opendal lands where an HTTP read looks.
    await (await accessor.operator()).write('b.txt', Buffer.from('written'))
    expect((await bucket.files())['pfx/b.txt']).toBe('written')
    expect(Buffer.from(await read(accessor, PathSpec.fromStrPath('/b.txt'))).toString()).toBe(
      'written',
    )
  })

  it('reads a name that needs encoding whole', async () => {
    const accessor = await accessorWith({ 'dir/Inkling_o (1)#.png': SEED })
    const data = await read(accessor, PathSpec.fromStrPath('/dir/Inkling_o (1)#.png'))
    expect(Buffer.from(data)).toEqual(SEED)
  })
})
