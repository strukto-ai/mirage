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

import { type FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket, TREE } from '../../../tests/fixtures/hf_bucket.ts'
import { readdir as listStats } from './readdir.ts'

let origin = ''
const buckets: HfBucket[] = []

beforeAll(async () => {
  origin = await serve('hf')
})

afterEach(async () => {
  await Promise.all(buckets.splice(0).map((bucket) => bucket.close()))
})

async function readdir(accessor: HfBucketsAccessor, path: PathSpec): Promise<string[]> {
  const rows = (await listStats(accessor, path)) as FileStat[]
  return rows.map((row) => `${path.virtual.replace(/\/+$/, '')}/${row.name}`)
}

// A bucket of its own after another client wrote `files` to it.
async function seeded(files: Record<string, string>): Promise<HfBucket> {
  const bucket = new HfBucket(origin)
  buckets.push(bucket)
  await bucket.reset()
  await bucket.put(files)
  return bucket
}

async function accessorWith(
  files: Record<string, string>,
  keyPrefix?: string,
): Promise<HfBucketsAccessor> {
  return (await seeded(files)).accessor(keyPrefix)
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
    const bucket = await seeded(FILES)
    const accessor = bucket.accessor()
    expect(await readdir(accessor, PathSpec.fromStrPath('/onnx'))).toEqual(['/onnx/model.onnx'])
    await bucket.remove('onnx/model.onnx')
    await expect(readdir(accessor, PathSpec.fromStrPath('/onnx'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('lists each size as its row has it', async () => {
    // One tree request and no stat. The Hub sends a size for every file
    // (its own client requires one); a row without one, which it does not
    // send, reads as 0 through opendal, whose row size defaults to 0, so
    // the listing never holds a missing size to fill.
    const bucket = await seeded({ 'data/a.txt': 'hello', 'data/b.txt': 'abc' })
    await bucket.run.recordRequests()
    await bucket.run.answerNext('GET', TREE, 200, [
      { type: 'file', path: 'data/a.txt', size: 5 },
      { type: 'file', path: 'data/b.txt' },
    ])
    const rows = (await listStats(bucket.accessor(), PathSpec.fromStrPath('/data'))) as FileStat[]
    expect(Object.fromEntries(rows.map((row) => [row.name, row.size]))).toEqual({
      'a.txt': 5,
      'b.txt': 0,
    })
    expect((await bucket.log()).map(([name]) => name)).toEqual(['tree'])
  })

  it('lists mount-relative under a key prefix', async () => {
    const accessor = await accessorWith(
      { 'pfx/a.txt': 'a', 'pfx/sub/b.txt': 'b', 'a.txt': 'decoy' },
      'pfx/',
    )
    const entries = await readdir(accessor, PathSpec.fromStrPath('/'))
    expect(entries).toEqual(['/a.txt', '/sub'])
  })
})
