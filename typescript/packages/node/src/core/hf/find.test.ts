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
import { resolveGlobOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { HF_IO } from '../../commands/builtin/hf/io.ts'
import { size, entries } from './du/index.ts'
import { DRIVER } from './driver.ts'
import { exists } from './exists.ts'
import { find } from './find.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { stat } from './stat.ts'

const resolveGlob = resolveGlobOf(HF_IO)

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
  'config.json': '{"a":1}',
  'model.safetensors': 'wwwwwwwwww',
  'onnx/model.onnx': 'xx',
  'onnx/sub/extra.txt': 'y',
}

describe('hf find', () => {
  it.each(['find', 'du'])('%s warmup preserves modification times', async (warmup) => {
    const accessor = new HfBucketsAccessor({ bucket: 'ns/model' })
    const fake = fakeHfOperator({ 'source.txt': 'old', 'dest.txt': 'new' })
    fake.modified.set('source.txt', '2025-01-01T00:00:00Z')
    fake.modified.set('dest.txt', '2026-01-01T00:00:00Z')
    await installFakeOperator(accessor, fake)
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/')
    if (warmup === 'find') await find(accessor, root, {}, index)
    else await size(accessor, root, index)
    for (const [key, when] of fake.modified) {
      const path = PathSpec.fromStrPath('/' + key)
      expect((await index.get(path.virtual)).entry?.remoteTime).toBe(when)
      // A warm stat answers from the listing's row; a cold one asks paths-info,
      // which is the token's source and not an mtime's, so it reports none, as
      // stat does against the live Hub today.
      expect((await stat(accessor, path, index)).modified).toBe(when)
      expect((await stat(accessor, path)).modified ?? null).toBeNull()
    }
  })

  it.each(['find', 'du'])('%s does not cache an omitted listing size as zero', async (command) => {
    const accessor = new HfBucketsAccessor({ bucket: 'ns/model' })
    const fake = fakeHfOperator({ 'config.json': '{"a":1}' })
    const realList = fake.list.bind(fake)
    fake.list = async (path, options) => {
      const rows = await realList(path, options)
      return rows.map((entry) => ({
        ...entry,
        metadata: () => ({ ...entry.metadata(), contentLength: null }),
      }))
    }
    await installFakeOperator(accessor, fake)
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/')
    if (command === 'find') await find(accessor, root, {}, index)
    else await size(accessor, root, index)
    expect((await index.get('/config.json')).entry).toBeUndefined()
    expect((await stat(accessor, PathSpec.fromStrPath('/config.json'), index)).size).toBe(7)
  })

  it('finds everything under root, including synthesized dirs', async () => {
    const accessor = await accessorWith(FILES)
    const results = await find(accessor, PathSpec.fromStrPath('/'))
    expect(results).toEqual([
      '/',
      '/config.json',
      '/model.safetensors',
      '/onnx',
      '/onnx/model.onnx',
      '/onnx/sub',
      '/onnx/sub/extra.txt',
    ])
  })

  it('filters by name pattern and type', async () => {
    const accessor = await accessorWith(FILES)
    expect(await find(accessor, PathSpec.fromStrPath('/'), { name: '*.json' })).toEqual([
      '/config.json',
    ])
    expect(await find(accessor, PathSpec.fromStrPath('/'), { type: 'd' })).toEqual([
      '/',
      '/onnx',
      '/onnx/sub',
    ])
  })

  it('filters by size and depth', async () => {
    const accessor = await accessorWith(FILES)
    expect(await find(accessor, PathSpec.fromStrPath('/'), { type: 'f', minSize: 5 })).toEqual([
      '/config.json',
      '/model.safetensors',
    ])
    expect(await find(accessor, PathSpec.fromStrPath('/'), { maxDepth: 1 })).toEqual([
      '/',
      '/config.json',
      '/model.safetensors',
      '/onnx',
    ])
  })

  it('scopes to a subdirectory and returns [] for missing dirs', async () => {
    const accessor = await accessorWith(FILES)
    expect(await find(accessor, PathSpec.fromStrPath('/onnx'))).toEqual([
      '/onnx',
      '/onnx/model.onnx',
      '/onnx/sub',
      '/onnx/sub/extra.txt',
    ])
    expect(await find(accessor, PathSpec.fromStrPath('/missing'))).toEqual([])
  })

  it('names paths mount-relative under a key prefix', async () => {
    const accessor = await accessorWith(
      { 'pfx/a.txt': 'a', 'pfx/sub/b.txt': 'b', 'a.txt': 'decoy', 'other/c.txt': 'c' },
      'pfx/',
    )
    expect(await find(accessor, PathSpec.fromStrPath('/'))).toEqual([
      '/',
      '/a.txt',
      '/sub',
      '/sub/b.txt',
    ])
  })
})

describe('hf du', () => {
  it.each(['2021-09-15T21:24:22Z', null])('keeps a file-stem timestamp of %s', async (modified) => {
    const accessor = new HfBucketsAccessor({ bucket: 'ns/model' })
    const fake = fakeHfOperator({ 'config.json': '{}' })
    const realStat = fake.stat.bind(fake)
    fake.stat = async (key) => ({ ...(await realStat(key)), lastModified: modified })
    await installFakeOperator(accessor, fake)
    const rows = []
    const conn = { accessor, op: await accessor.operator() }
    for await (const row of DRIVER.listSubtree(conn, 'config.json')) {
      rows.push(row)
    }
    expect(rows).toEqual([{ key: 'config.json', size: 2, modified: modified ?? '' }])
  })

  it('sums file sizes recursively', async () => {
    const accessor = await accessorWith(FILES)
    expect(await size(accessor, PathSpec.fromStrPath('/'))).toBe(20)
    expect(await size(accessor, PathSpec.fromStrPath('/onnx'))).toBe(3)
    expect(await size(accessor, PathSpec.fromStrPath('/missing'))).toBe(0)
  })

  it('duEntries lists per-file sizes plus a total', async () => {
    const accessor = await accessorWith(FILES)
    const [rows, total] = await entries(accessor, PathSpec.fromStrPath('/onnx'))
    expect(rows).toEqual([
      ['/onnx/model.onnx', 2],
      ['/onnx/sub/extra.txt', 1],
    ])
    expect(total).toBe(3)
  })
})

describe('hf exists', () => {
  it('reports files, dirs, and missing paths', async () => {
    const accessor = await accessorWith(FILES)
    expect(await exists(accessor, PathSpec.fromStrPath('/config.json'))).toBe(true)
    expect(await exists(accessor, PathSpec.fromStrPath('/onnx'))).toBe(true)
    expect(await exists(accessor, PathSpec.fromStrPath('/nope'))).toBe(false)
  })

  it.each([
    [401, ''],
    [404, 'RepoNotFound'],
  ])('raises on a refused bucket (%i %s)', async (status, code) => {
    // A bucket the Hub will not show is not a missing file: false here would
    // let a caller conclude it can create the path.
    const accessor = new HfBucketsAccessor({ bucket: 'ns/model' })
    const hub = await installFakeOperator(accessor, fakeHfOperator({ 'a.txt': 'x' }))
    hub.fail.set('bucket_paths_info', [status, code])
    await expect(exists(accessor, PathSpec.fromStrPath('/a.txt'))).rejects.toMatchObject({
      code: 'EACCES',
    })
  })
})

describe('hf resolveGlob', () => {
  it('expands patterns against readdir entries', async () => {
    const accessor = await accessorWith(FILES)
    const spec = new PathSpec({
      vfsPath: '*.json',
      virtual: '/*.json',
      directory: '/',
      pattern: '*.json',
      resolved: false,
    })
    const resolved = await resolveGlob(accessor, [spec])
    expect(resolved.map((p) => p.virtual)).toEqual(['/config.json'])
  })

  it('passes through resolved and pattern-free specs', async () => {
    const accessor = await accessorWith(FILES)
    const plain = PathSpec.fromStrPath('/config.json')
    const resolved = await resolveGlob(accessor, [plain])
    expect(resolved).toEqual([plain])
  })
})
