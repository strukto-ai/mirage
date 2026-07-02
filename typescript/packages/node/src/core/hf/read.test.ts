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

import { PathSpec, mountKey } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { HfModelsAccessor } from '../../accessor/hf.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { read } from './read.ts'

function accessorWith(files: Record<string, string | Buffer>): HfModelsAccessor {
  const accessor = new HfModelsAccessor({ repoId: 'ns/model' })
  installFakeOperator(accessor, fakeHfOperator(files))
  return accessor
}

describe('hf read', () => {
  it('reads full file bytes', async () => {
    const accessor = accessorWith({ 'config.json': '{"a":1}' })
    const data = await read(accessor, PathSpec.fromStrPath('/config.json'))
    expect(Buffer.from(data).toString()).toBe('{"a":1}')
  })

  it('strips the mount prefix from the key', async () => {
    const accessor = accessorWith({ 'sub/file.txt': 'hello' })
    const data = await read(
      accessor,
      PathSpec.fromStrPath('/m/sub/file.txt', mountKey('/m/sub/file.txt', '/m')),
    )
    expect(Buffer.from(data).toString()).toBe('hello')
  })

  it('honors offset and size', async () => {
    const accessor = accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await read(accessor, PathSpec.fromStrPath('/f.bin'), undefined, {
      offset: 2,
      size: 3,
    })
    expect(Buffer.from(data).toString()).toBe('cde')
  })

  it('honors size without offset', async () => {
    const accessor = accessorWith({ 'f.bin': 'abcdefgh' })
    const data = await read(accessor, PathSpec.fromStrPath('/f.bin'), undefined, { size: 4 })
    expect(Buffer.from(data).toString()).toBe('abcd')
  })

  it('maps NotFound to ENOENT', async () => {
    const accessor = accessorWith({})
    await expect(read(accessor, PathSpec.fromStrPath('/missing.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
