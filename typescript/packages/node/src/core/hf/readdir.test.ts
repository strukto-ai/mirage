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
import { PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { readdir } from './readdir.ts'

async function accessorWith(
  files: Record<string, string | Buffer>,
  keyPrefix?: string,
): Promise<HfBucketsAccessor> {
  const accessor = new HfBucketsAccessor(
    keyPrefix === undefined ? { bucket: 'ns/model' } : { bucket: 'ns/model', keyPrefix },
  )
  await installFakeOperator(accessor, fakeHfOperator(files))
  return accessor
}

const FILES = {
  'config.json': '{}',
  'model.safetensors': 'wwww',
  'onnx/model.onnx': 'x',
}

describe('hf readdir', () => {
  it('lists the root one level deep, sorted', async () => {
    const accessor = await accessorWith(FILES)
    const entries = await readdir(accessor, PathSpec.fromStrPath('/'))
    expect(entries).toEqual(['/config.json', '/model.safetensors', '/onnx'])
  })

  it('lists a subdirectory with root-relative paths', async () => {
    const accessor = await accessorWith(FILES)
    const entries = await readdir(accessor, PathSpec.fromStrPath('/onnx'))
    expect(entries).toEqual(['/onnx/model.onnx'])
  })

  it('applies the mount prefix to returned entries', async () => {
    const accessor = await accessorWith(FILES)
    const entries = await readdir(
      accessor,
      PathSpec.fromStrPath('/m/onnx', mountKey('/m/onnx', '/m')),
    )
    expect(entries).toEqual(['/m/onnx/model.onnx'])
  })

  it('raises ENOENT for a missing directory', async () => {
    const accessor = await accessorWith(FILES)
    await expect(readdir(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('raises ENOENT for a missing nested directory', async () => {
    const accessor = await accessorWith(FILES)
    await expect(readdir(accessor, PathSpec.fromStrPath('/onnx/nodir/deep'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })

  it('raises ENOTDIR for a file listed as a directory', async () => {
    const accessor = await accessorWith(FILES)
    await expect(readdir(accessor, PathSpec.fromStrPath('/config.json'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('raises ENOTDIR for an operand under a file', async () => {
    // A repo holds no directory objects, so the tree API can answer a path
    // it does not have with an empty listing rather than an error; without
    // a check `ls /hf/config.json/x` rendered an empty directory, exit 0.
    const accessor = await accessorWith(FILES)
    await expect(readdir(accessor, PathSpec.fromStrPath('/config.json/x'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('does not raise for the root of an empty repo', async () => {
    const accessor = await accessorWith({})
    expect(await readdir(accessor, PathSpec.fromStrPath('/'))).toEqual([])
  })

  it('keeps a directory only while it holds a key', async () => {
    // The hf service refuses a directory marker client-side, so unlike s3
    // there is no empty-directory trace to keep: removing the last key
    // removes the directory, which is what stat has always reported.
    const accessor = new HfBucketsAccessor({ bucket: 'ns/model' })
    const fake = fakeHfOperator(FILES)
    await installFakeOperator(accessor, fake)
    expect(await readdir(accessor, PathSpec.fromStrPath('/onnx'))).toEqual(['/onnx/model.onnx'])
    await fake.delete('onnx/model.onnx')
    await expect(readdir(accessor, PathSpec.fromStrPath('/onnx'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('backfills a lister-omitted size with one stat', async () => {
    const accessor = await accessorWith(FILES)
    const fake = fakeHfOperator(FILES)
    const realList = fake.list.bind(fake)
    fake.list = async (path, options) => {
      const entries = await realList(path, options)
      return entries.map((entry) =>
        entry.path() === 'config.json'
          ? { ...entry, metadata: () => ({ ...entry.metadata(), contentLength: null }) }
          : entry,
      )
    }
    await installFakeOperator(accessor, fake)
    const index = new RAMIndexCacheStore()
    await readdir(accessor, PathSpec.fromStrPath('/'), index)
    const lookup = await index.get('/config.json')
    expect(lookup.entry?.size).toBe(2)
  })

  it('populates the index and serves the second call from cache', async () => {
    const accessor = await accessorWith(FILES)
    const index = new RAMIndexCacheStore()
    const first = await readdir(accessor, PathSpec.fromStrPath('/'), index)
    await installFakeOperator(accessor, fakeHfOperator({}))
    const second = await readdir(accessor, PathSpec.fromStrPath('/'), index)
    expect(second).toEqual(first)
  })

  it('lists mount-relative under a key prefix', async () => {
    const accessor = await accessorWith(
      { 'pfx/a.txt': 'a', 'pfx/sub/b.txt': 'b', 'a.txt': 'decoy' },
      'pfx/',
    )
    const entries = await readdir(accessor, PathSpec.fromStrPath('/'), new RAMIndexCacheStore())
    expect(entries).toEqual(['/a.txt', '/sub'])
  })
})
