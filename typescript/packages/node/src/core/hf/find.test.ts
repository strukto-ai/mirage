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

import { PathSpec, resolveGlobOf } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { HfModelsAccessor } from '../../accessor/hf.ts'
import { HF_IO } from '../../commands/builtin/hf/io.ts'
import { du, duAll } from './du.ts'
import { exists } from './exists.ts'
import { find } from './find.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'

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
  it('sums file sizes recursively', async () => {
    const accessor = accessorWith(FILES)
    expect(await du(accessor, PathSpec.fromStrPath('/'))).toBe(20)
    expect(await du(accessor, PathSpec.fromStrPath('/onnx'))).toBe(3)
    expect(await du(accessor, PathSpec.fromStrPath('/missing'))).toBe(0)
  })

  it('duAll lists per-file sizes plus a total', async () => {
    const accessor = accessorWith(FILES)
    const [rows, total] = await duAll(accessor, PathSpec.fromStrPath('/onnx'))
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
      resourcePath: '*.json',
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
