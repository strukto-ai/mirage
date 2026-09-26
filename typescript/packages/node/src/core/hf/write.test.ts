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

import { PathSpec } from '@struktoai/mirage-core/types'
import { errorVirtualPath } from '@struktoai/mirage-core/utils/errors'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { create } from './create.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { mkdir } from './mkdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

async function setup(files: Record<string, string | Buffer> = {}): Promise<{
  accessor: HfBucketsAccessor
  fake: ReturnType<typeof fakeHfOperator>
}> {
  const accessor = new HfBucketsAccessor({ bucket: 'ns/store' })
  const fake = fakeHfOperator(files)
  await installFakeOperator(accessor, fake)
  return { accessor, fake }
}

// Refuses writes the way a missing repo or revision does.
function missingRepo(): ReturnType<typeof fakeHfOperator> {
  const fake = fakeHfOperator()
  fake.write = () =>
    Promise.reject(new Error('NotFound (permanent) at write, context: { service: hf }'))
  return fake
}

async function caught(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('hf write', () => {
  it('writes bytes to the backend key', async () => {
    const { accessor, fake } = await setup()
    await write(accessor, PathSpec.fromStrPath('/out.txt'), new TextEncoder().encode('hello'))
    expect(fake.files.get('out.txt')?.toString()).toBe('hello')
  })

  it('strips the mount prefix from the key', async () => {
    const { accessor, fake } = await setup()
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
    const { accessor, fake } = await setup()
    await create(accessor, PathSpec.fromStrPath('/empty.txt'))
    expect(fake.files.get('empty.txt')?.byteLength).toBe(0)
  })
})

describe('hf unlink', () => {
  it('deletes an existing file', async () => {
    const { accessor, fake } = await setup({ 'a.txt': 'x' })
    await unlink(accessor, PathSpec.fromStrPath('/a.txt'))
    expect(fake.files.has('a.txt')).toBe(false)
  })

  it('leaves a directory subtree untouched', async () => {
    // The op is a blind single-key delete; the "Is a directory" refusal
    // lives in the generic rm builder, which stats before unlinking. A
    // directory owns no key of its own, so this must touch nothing.
    const { accessor, fake } = await setup({ 'dir/a.txt': 'x' })
    await expect(unlink(accessor, PathSpec.fromStrPath('/dir'))).resolves.toBeUndefined()
    expect(fake.files.has('dir/a.txt')).toBe(true)
  })

  it('is silent on a missing key', async () => {
    // Per the driver contract; the "No such file or directory" refusal
    // is the rm builder's, from the stat it takes before unlinking.
    const { accessor } = await setup()
    await expect(unlink(accessor, PathSpec.fromStrPath('/nope'))).resolves.toBeUndefined()
  })
})

describe('hf mkdir', () => {
  it('is a no-op', async () => {
    const { accessor } = await setup()
    await expect(mkdir(accessor, PathSpec.fromStrPath('/newdir'))).resolves.toBeUndefined()
  })
})

describe('hf write on a missing repo', () => {
  it('a write names the virtual path', async () => {
    // The driver's put speaks keys ("out.txt"), so letting its error
    // through would put a backend key in a user-facing message; the kit's
    // write factory restates it on the path the user typed.
    const accessor = new HfBucketsAccessor({ bucket: 'ns/store' })
    await installFakeOperator(accessor, missingRepo())
    const err = await caught(() =>
      write(accessor, PathSpec.fromStrPath('/out.txt'), new TextEncoder().encode('hi')),
    )
    expect((err as { code?: string }).code).toBe('ENOENT')
    expect(errorVirtualPath(err)).toBe('/out.txt')
  })

  it('a create names the virtual path', async () => {
    const accessor = new HfBucketsAccessor({ bucket: 'ns/store' })
    await installFakeOperator(accessor, missingRepo())
    const err = await caught(() => create(accessor, PathSpec.fromStrPath('/new.txt')))
    expect(errorVirtualPath(err)).toBe('/new.txt')
  })
})
