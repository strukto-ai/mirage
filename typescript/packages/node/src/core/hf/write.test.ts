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
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { create } from './create.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { mkdir } from './mkdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

function setup(files: Record<string, string | Buffer> = {}): {
  accessor: HfBucketsAccessor
  fake: ReturnType<typeof fakeHfOperator>
} {
  const accessor = new HfBucketsAccessor({ bucket: 'ns/store' })
  const fake = fakeHfOperator(files)
  installFakeOperator(accessor, fake)
  return { accessor, fake }
}

describe('hf write', () => {
  it('writes bytes to the backend key', async () => {
    const { accessor, fake } = setup()
    await write(accessor, PathSpec.fromStrPath('/out.txt'), new TextEncoder().encode('hello'))
    expect(fake.files.get('out.txt')?.toString()).toBe('hello')
  })

  it('strips the mount prefix from the key', async () => {
    const { accessor, fake } = setup()
    await write(
      accessor,
      PathSpec.fromStrPath('/m/sub/out.txt', mountKey('/m/sub/out.txt', '/m')),
      Buffer.from('x'),
    )
    expect(fake.files.has('sub/out.txt')).toBe(true)
  })
})

describe('hf create', () => {
  it('creates an empty file', async () => {
    const { accessor, fake } = setup()
    await create(accessor, PathSpec.fromStrPath('/empty.txt'))
    expect(fake.files.get('empty.txt')?.byteLength).toBe(0)
  })
})

describe('hf unlink', () => {
  it('deletes an existing file', async () => {
    const { accessor, fake } = setup({ 'a.txt': 'x' })
    await unlink(accessor, PathSpec.fromStrPath('/a.txt'))
    expect(fake.files.has('a.txt')).toBe(false)
  })

  it('raises EISDIR for directories', async () => {
    const { accessor } = setup({ 'dir/a.txt': 'x' })
    await expect(unlink(accessor, PathSpec.fromStrPath('/dir'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('raises ENOENT for missing files', async () => {
    const { accessor } = setup()
    await expect(unlink(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('hf mkdir', () => {
  it('is a no-op', async () => {
    const { accessor } = setup()
    await expect(mkdir(accessor, PathSpec.fromStrPath('/newdir'))).resolves.toBeUndefined()
  })
})
