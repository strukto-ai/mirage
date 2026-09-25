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

import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfHubError } from '../hf_hub/client.ts'
import { type FakeHub, NO_ETAG, xetHash } from '../hf_hub/_test_util.ts'
import { type FakeHfOperator, fakeHfOperator, installFakeOperator } from './mock.ts'
import { read } from './read.ts'

const SEED = Buffer.from('name,age\nalice,30\n')

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

async function stamped(
  accessor: HfBucketsAccessor,
  path: string,
  options: { offset?: number; size?: number } = {},
): Promise<[Uint8Array, (string | null)[]]> {
  const [data, records] = await runWithRecording(() =>
    read(accessor, PathSpec.fromStrPath(path), undefined, options),
  )
  return [data, records.map((r) => r.fingerprint ?? null)]
}

describe('hf read', () => {
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
    const data = await read(accessor, PathSpec.fromStrPath('/f.bin'), undefined, {
      offset: 2,
      size: 3,
    })
    expect(Buffer.from(data).toString()).toBe('cde')
  })

  it('honors size without offset', async () => {
    const accessor = await accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await read(accessor, PathSpec.fromStrPath('/f.bin'), undefined, { size: 4 })
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
    const { accessor, fake, hub } = await mounted({ 'a.txt': SEED })
    fake.reach = []
    const [data, stamps] = await stamped(accessor, '/a.txt', window)
    expect(Buffer.from(data)).toEqual(Buffer.from(expected))
    // The strong ETag the bytes came with is the xet hash stat reports, for a
    // ranged 206 as for a whole read (measured 2026-09-25).
    expect(stamps).toEqual([xetHash(SEED)])
    expect([hub.count('bucket_resolve'), hub.count('bucket_paths_info')]).toEqual([1, 0])
    expect(fake.reach).toEqual([])
  })

  it.each([
    ['"other"', 'other'],
    [`W/"${xetHash(SEED)}"`, null],
    ['""', null],
    [NO_ETAG, null],
  ])('stamps only the response own strong etag (%s)', async (served, stamp) => {
    // "other" proves the token rides the read itself rather than a second
    // request; a weak validator does not vouch for bytes, and an empty or
    // missing one stamps nothing rather than "".
    const { accessor, hub } = await mounted({ 'a.txt': SEED })
    hub.etags.set('a.txt', served)
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
    const { accessor, hub } = await mounted({ 'a.txt': SEED })
    hub.fail.set('bucket_resolve', [status, code])
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
    const { accessor, hub } = await mounted({ pfx: 'stem', 'pfx/a.txt': SEED }, 'pfx/')
    await expect(read(accessor, PathSpec.fromStrPath('/'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(hub.count('bucket_resolve')).toBe(0)
  })

  it('reads a directory key directly as absent', async () => {
    // resolve on a directory key answers 404 EntryNotFound (measured 2026-09-25).
    const accessor = await accessorWith({ 'd/x.txt': 'x' })
    await expect(read(accessor, PathSpec.fromStrPath('/d'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reads a window past EOF as empty and stamps nothing', async () => {
    const { accessor, hub } = await mounted({ 'a.txt': 'abc' })
    const [data, stamps] = await stamped(accessor, '/a.txt', { offset: 99, size: 5 })
    expect([data.byteLength, stamps]).toEqual([0, [null]])
    // The Hub answers 416 here (measured 2026-09-25); the fold is the read's
    // own, since a caller reading the range directly has no other.
    expect(hub.statuses).toContainEqual(['bucket_cdn', 416])
    const [short] = await stamped(accessor, '/a.txt', { offset: 0, size: 100 })
    expect(Buffer.from(short).toString()).toBe('abc')
  })

  it('answers a zero-length window empty without a request', async () => {
    // The table's range door reaches here with no factory short-circuit, and a
    // zero-length Range header is not one the client can build.
    const { accessor, hub } = await mounted({ 'a.txt': 'abc' })
    const data = await read(accessor, PathSpec.fromStrPath('/a.txt'), undefined, {
      offset: 1,
      size: 0,
    })
    expect([data.byteLength, hub.count('bucket_resolve')]).toEqual([0, 0])
  })

  it('serves the prefixed object under a key prefix', async () => {
    const { accessor, fake } = await mounted({ 'pfx/a.txt': SEED, 'a.txt': 'decoy' }, 'pfx/')
    expect(Buffer.from(await read(accessor, PathSpec.fromStrPath('/a.txt')))).toEqual(SEED)
    const window = await read(accessor, PathSpec.fromStrPath('/a.txt'), undefined, {
      offset: 5,
      size: 3,
    })
    expect(Buffer.from(window)).toEqual(SEED.subarray(5, 8))
    // A write through opendal lands where an HTTP read looks.
    await fake.write('b.txt', 'written')
    expect(fake.files.get('pfx/b.txt')?.toString()).toBe('written')
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
