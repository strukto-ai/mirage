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
import { HfModelsAccessor } from '../../accessor/hf.ts'
import { HF_IO } from '../../commands/builtin/hf/io.ts'
import { size, entries } from './du/index.ts'
import { DRIVER } from './driver.ts'
import { exists } from './exists.ts'
import { find } from './find.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { stat } from './stat.ts'

const resolveGlob = resolveGlobOf(HF_IO)

function accessorWith(files: Record<string, string | Buffer>): HfModelsAccessor {
  const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
  installFakeOperator(accessor, fakeHfOperator(files))
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
    const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
    const fake = fakeHfOperator({ 'source.txt': 'old', 'dest.txt': 'new' })
    const modified = (key: string): string =>
      key === 'source.txt' ? '2025-01-01T00:00:00Z' : '2026-01-01T00:00:00Z'
    const realList = fake.list.bind(fake)
    const realStat = fake.stat.bind(fake)
    fake.list = async (path, options) =>
      (await realList(path, options)).map((entry) => ({
        ...entry,
        metadata: () => ({ ...entry.metadata(), lastModified: modified(entry.path()) }),
      }))
    fake.stat = async (key) => ({ ...(await realStat(key)), lastModified: modified(key) })
    installFakeOperator(accessor, fake)
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/')
    if (warmup === 'find') await find(accessor, root, {}, index)
    else await size(accessor, root, index)
    for (const key of fake.files.keys()) {
      const path = PathSpec.fromStrPath('/' + key)
      expect((await index.get(path.virtual)).entry?.remoteTime).toBe(modified(key))
      expect((await stat(accessor, path, index)).modified).toBe(modified(key))
    }
  })

  it.each(['find', 'du'])('%s does not cache an omitted listing size as zero', async (command) => {
    const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
    const fake = fakeHfOperator({ 'config.json': '{"a":1}' })
    const realList = fake.list.bind(fake)
    fake.list = async (path, options) => {
      const rows = await realList(path, options)
      return rows.map((entry) => ({
        ...entry,
        metadata: () => ({ ...entry.metadata(), contentLength: null }),
      }))
    }
    installFakeOperator(accessor, fake)
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/')
    if (command === 'find') await find(accessor, root, {}, index)
    else await size(accessor, root, index)
    expect((await index.get('/config.json')).entry).toBeUndefined()
    expect((await stat(accessor, PathSpec.fromStrPath('/config.json'), index)).size).toBe(7)
  })

  it('finds everything under root, including synthesized dirs', async () => {
    const accessor = accessorWith(FILES)
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
    const accessor = accessorWith(FILES)
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
    const accessor = accessorWith(FILES)
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
    const accessor = accessorWith(FILES)
    expect(await find(accessor, PathSpec.fromStrPath('/onnx'))).toEqual([
      '/onnx',
      '/onnx/model.onnx',
      '/onnx/sub',
      '/onnx/sub/extra.txt',
    ])
    expect(await find(accessor, PathSpec.fromStrPath('/missing'))).toEqual([])
  })
})

describe('hf du', () => {
  it.each(['2021-09-15T21:24:22Z', null])('keeps a file-stem timestamp of %s', async (modified) => {
    const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
    const fake = fakeHfOperator({ 'config.json': '{}' })
    const realStat = fake.stat.bind(fake)
    fake.stat = async (key) => ({ ...(await realStat(key)), lastModified: modified })
    installFakeOperator(accessor, fake)
    const rows = []
    for await (const row of DRIVER.listSubtree(await accessor.operator(), 'config.json')) {
      rows.push(row)
    }
    expect(rows).toEqual([{ key: 'config.json', size: 2, modified: modified ?? '' }])
  })

  it('sums file sizes recursively', async () => {
    const accessor = accessorWith(FILES)
    expect(await size(accessor, PathSpec.fromStrPath('/'))).toBe(20)
    expect(await size(accessor, PathSpec.fromStrPath('/onnx'))).toBe(3)
    expect(await size(accessor, PathSpec.fromStrPath('/missing'))).toBe(0)
  })

  it('duEntries lists per-file sizes plus a total', async () => {
    const accessor = accessorWith(FILES)
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
    const accessor = accessorWith(FILES)
    expect(await exists(accessor, PathSpec.fromStrPath('/config.json'))).toBe(true)
    expect(await exists(accessor, PathSpec.fromStrPath('/onnx'))).toBe(true)
    expect(await exists(accessor, PathSpec.fromStrPath('/nope'))).toBe(false)
  })
})

describe('hf resolveGlob', () => {
  it('expands patterns against readdir entries', async () => {
    const accessor = accessorWith(FILES)
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
    const accessor = accessorWith(FILES)
    const plain = PathSpec.fromStrPath('/config.json')
    const resolved = await resolveGlob(accessor, [plain])
    expect(resolved).toEqual([plain])
  })
})
