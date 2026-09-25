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

import { recordingActive, runWithRecording } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HfHubError } from '../hf_hub/client.ts'
import { type FakeHub, NO_ETAG, xetHash } from '../hf_hub/_test_util.ts'
import { type FakeHfOperator, fakeHfOperator, installFakeOperator } from './mock.ts'
import { rangeRead, stream } from './stream.ts'

const BIG = Buffer.from(`${'x'.repeat(1023)}\n`.repeat(300))

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

async function drain(accessor: HfBucketsAccessor, path: string): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream(accessor, PathSpec.fromStrPath(path))) chunks.push(chunk)
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
    const { accessor, fake } = await mounted({ 'big.bin': BIG })
    fake.reach = []
    const [[chunks, first], records] = await runWithRecording(async () => {
      const iter = stream(accessor, PathSpec.fromStrPath('/big.bin'))[Symbol.asyncIterator]()
      return [iter, await iter.next()] as const
    })
    // Checked while the generator is suspended at its first yield: a consumer
    // that stops here (head -c) still leaves a record naming the bytes.
    expect(records.map((r) => r.fingerprint)).toEqual([xetHash(BIG)])
    const parts: Uint8Array[] = first.done === true ? [] : [first.value]
    for (let next = await chunks.next(); next.done !== true; next = await chunks.next()) {
      parts.push(next.value)
    }
    expect(Buffer.concat(parts)).toEqual(BIG)
    expect(fake.reach).toEqual([])
  })

  it('stamps an empty stream too', async () => {
    const accessor = await accessorWith({ empty: '' })
    const [data, records] = await runWithRecording(() => drain(accessor, '/empty'))
    expect(data.byteLength).toBe(0)
    expect(records.map((r) => r.fingerprint)).toEqual([xetHash(Buffer.from(''))])
  })

  it('does not crash with no recorder bound', async () => {
    const accessor = await accessorWith({ x: 'abc' })
    expect(recordingActive()).toBe(false)
    expect((await drain(accessor, '/x')).toString()).toBe('abc')
  })

  it.each([['W/"abc"'], [NO_ETAG]])('stamps nothing without a strong etag (%s)', async (served) => {
    const { accessor, hub } = await mounted({ x: 'abc' })
    hub.etags.set('x', served)
    const [, records] = await runWithRecording(() => drain(accessor, '/x'))
    expect(records.map((r) => r.fingerprint ?? null)).toEqual([null])
  })

  it.each([
    [404, 'EntryNotFound', 'ENOENT'],
    [404, '', 'raw'],
    [401, '', 'EACCES'],
    [403, '', 'EACCES'],
    [400, '', 'raw'],
  ])('is absent only for a missing entry (%i %s)', async (status, code, want) => {
    const { accessor, hub } = await mounted({ 'a.txt': 'abc' })
    hub.fail.set('bucket_resolve', [status, code])
    const err = await drain(accessor, '/a.txt').catch((e: unknown) => e)
    if (want === 'raw') {
      expect(err).toBeInstanceOf(HfHubError)
      expect((err as { code?: string }).code).toBeUndefined()
    } else {
      expect(err).toMatchObject({ code: want })
    }
  })

  it('answers the mount root as a directory', async () => {
    const { accessor, hub } = await mounted({ pfx: 'stem', 'pfx/a.txt': 'a' }, 'pfx/')
    await expect(drain(accessor, '/')).rejects.toMatchObject({ code: 'EISDIR' })
    expect(hub.count('bucket_resolve')).toBe(0)
  })

  it('serves the prefixed object under a key prefix', async () => {
    const { accessor } = await mounted({ 'pfx/a.txt': 'seed', 'a.txt': 'decoy' }, 'pfx/')
    expect((await drain(accessor, '/a.txt')).toString()).toBe('seed')
    const window = await rangeRead(accessor, PathSpec.fromStrPath('/a.txt'), 1, 3)
    expect(Buffer.from(window).toString()).toBe('ee')
  })
})

describe('hf rangeRead', () => {
  it('reads the [start, end) byte range', async () => {
    const accessor = await accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await rangeRead(accessor, PathSpec.fromStrPath('/f.bin'), 2, 5)
    expect(Buffer.from(data).toString()).toBe('cde')
  })

  it('reads from zero', async () => {
    const accessor = await accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await rangeRead(accessor, PathSpec.fromStrPath('/f.bin'), 0, 3)
    expect(Buffer.from(data).toString()).toBe('abc')
  })
})
