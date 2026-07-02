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

import { PathSpec, RAMIndexCacheStore, mountKey } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { HfModelsAccessor } from '../../accessor/hf.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { readdir } from './readdir.ts'

function accessorWith(files: Record<string, string | Buffer>): HfModelsAccessor {
  const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
  installFakeOperator(accessor, fakeHfOperator(files))
  return accessor
}

const FILES = {
  'config.json': '{}',
  'model.safetensors': 'wwww',
  'onnx/model.onnx': 'x',
}

describe('hf readdir', () => {
  it('lists the root one level deep, sorted', async () => {
    const accessor = accessorWith(FILES)
    const entries = await readdir(accessor, PathSpec.fromStrPath('/'))
    expect(entries).toEqual(['/config.json', '/model.safetensors', '/onnx'])
  })

  it('lists a subdirectory with root-relative paths', async () => {
    const accessor = accessorWith(FILES)
    const entries = await readdir(accessor, PathSpec.fromStrPath('/onnx'))
    expect(entries).toEqual(['/onnx/model.onnx'])
  })

  it('applies the mount prefix to returned entries', async () => {
    const accessor = accessorWith(FILES)
    const entries = await readdir(
      accessor,
      PathSpec.fromStrPath('/m/onnx', mountKey('/m/onnx', '/m')),
    )
    expect(entries).toEqual(['/m/onnx/model.onnx'])
  })

  it('raises ENOENT for a missing directory', async () => {
    const accessor = accessorWith(FILES)
    await expect(readdir(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('populates the index and serves the second call from cache', async () => {
    const accessor = accessorWith(FILES)
    const index = new RAMIndexCacheStore()
    const first = await readdir(accessor, PathSpec.fromStrPath('/'), index)
    installFakeOperator(accessor, fakeHfOperator({}))
    const second = await readdir(accessor, PathSpec.fromStrPath('/'), index)
    expect(second).toEqual(first)
  })
})
