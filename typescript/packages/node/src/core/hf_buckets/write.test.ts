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

import { CHUNK_SIZE } from '@struktoai/mirage-core/io/cooperative'
import { PathSpec } from '@struktoai/mirage-core/types'
import { errorVirtualPath } from '@struktoai/mirage-core/errors/fs'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import type { Operator } from 'opendal'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { HfBucketsAccessor } from '../../accessor/hf_buckets.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket } from '../../../tests/fixtures/hf_bucket.ts'
import { create } from './create.ts'
import { mkdir } from './mkdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

const COMMIT = '/api/buckets/:ns/:name/batch'

let origin = ''
const buckets: HfBucket[] = []

beforeAll(async () => {
  origin = await serve('hf')
})

afterEach(async () => {
  await Promise.all(buckets.splice(0).map((bucket) => bucket.close()))
})

async function setup(
  files: Record<string, string> = {},
): Promise<{ accessor: HfBucketsAccessor; bucket: HfBucket }> {
  const bucket = new HfBucket(origin)
  buckets.push(bucket)
  await bucket.reset()
  await bucket.put(files)
  return { accessor: bucket.accessor(), bucket }
}

// The Hub refuses the commit of a write to a repository it does not have
// with 404 RepoNotFound, which opendal reports as NotFound.
async function missingRepo(bucket: HfBucket): Promise<void> {
  await bucket.run.answerNext(
    'POST',
    COMMIT,
    404,
    { error: 'Repository not found' },
    1,
    undefined,
    undefined,
    0,
    { 'X-Error-Code': 'RepoNotFound', 'X-Error-Message': 'Repository not found' },
  )
}

interface Handed {
  total: number
  largest: number
  closed: boolean
}

// The real writer, each chunk the write hands it counted on its way.
function counted(op: Operator): Handed {
  const handed: Handed = { total: 0, largest: 0, closed: false }
  const writer = op.writer.bind(op)
  Object.defineProperty(op, 'writer', {
    value: async (...args: Parameters<Operator['writer']>) => {
      const real = await writer(...args)
      return {
        write: (data: Buffer) => {
          handed.total += data.byteLength
          handed.largest = Math.max(handed.largest, data.byteLength)
          return real.write(data)
        },
        close: async () => {
          await real.close()
          handed.closed = true
        },
      }
    },
  })
  return handed
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('hf write', () => {
  it('writes bytes to the backend key', async () => {
    const { accessor, bucket } = await setup()
    await write(accessor, PathSpec.fromStrPath('/out.txt'), new TextEncoder().encode('hello'))
    expect((await bucket.files())['out.txt']).toBe('hello')
  })

  it('strips the mount prefix from the key', async () => {
    const { accessor, bucket } = await setup()
    await write(
      accessor,
      PathSpec.fromStrPath('/m/sub/out.txt', mountKey('/m/sub/out.txt', '/m')),
      Buffer.from('x'),
    )
    expect(Object.keys(await bucket.files())).toEqual(['sub/out.txt'])
  })
})

describe('hf streamed write', () => {
  it('hands the writer one chunk at a time and commits on close', async () => {
    const { accessor, bucket } = await setup()
    const handed = counted(await accessor.operator())
    const block = new Uint8Array(1024 * 1024)
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 64; i++) yield await Promise.resolve(block)
    }
    const written = await write(accessor, PathSpec.fromStrPath('/big.bin'), source())
    expect([handed.total, handed.closed, written?.size]).toEqual([
      64 * block.byteLength,
      true,
      handed.total,
    ])
    expect(handed.largest).toBeLessThanOrEqual(CHUNK_SIZE)
    expect((await bucket.row('big.bin')).size).toBe(64 * block.byteLength)
  })

  it('commits nothing when the stream fails', async () => {
    const { accessor, bucket } = await setup()
    async function* source(): AsyncGenerator<Uint8Array> {
      yield await Promise.resolve(new TextEncoder().encode('partial'))
      throw new Error('producer failed')
    }
    await expect(write(accessor, PathSpec.fromStrPath('/out.txt'), source())).rejects.toThrow(
      'producer failed',
    )
    expect(await bucket.files()).toEqual({})
  })
})

describe('hf create', () => {
  it('creates an empty file', async () => {
    const { accessor, bucket } = await setup()
    await create(accessor, PathSpec.fromStrPath('/empty.txt'))
    expect(await bucket.files()).toEqual({ 'empty.txt': '' })
  })
})

describe('hf unlink', () => {
  it('deletes an existing file', async () => {
    const { accessor, bucket } = await setup({ 'a.txt': 'x' })
    await unlink(accessor, PathSpec.fromStrPath('/a.txt'))
    expect(await bucket.files()).toEqual({})
  })

  it('refuses a directory and leaves its subtree untouched', async () => {
    // unlink(2) refuses a directory with EISDIR, and the op answers it
    // itself: a guest, FUSE and ws.vfs reach it without the rm builder's
    // stat. A directory owns no key of its own, so nothing is touched.
    const { accessor, bucket } = await setup({ 'dir/a.txt': 'x' })
    await expect(unlink(accessor, PathSpec.fromStrPath('/dir'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(await bucket.files()).toEqual({ 'dir/a.txt': 'x' })
  })

  it('refuses a missing key', async () => {
    // unlink(2) answers ENOENT, which the store's own delete never says.
    const { accessor } = await setup()
    await expect(unlink(accessor, PathSpec.fromStrPath('/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
    const { accessor, bucket } = await setup()
    await missingRepo(bucket)
    const err = await caught(() =>
      write(accessor, PathSpec.fromStrPath('/out.txt'), new TextEncoder().encode('hi')),
    )
    expect((err as { code?: string }).code).toBe('ENOENT')
    expect(errorVirtualPath(err)).toBe('/out.txt')
  })

  it('a create names the virtual path', async () => {
    const { accessor, bucket } = await setup()
    await missingRepo(bucket)
    const err = await caught(() => create(accessor, PathSpec.fromStrPath('/new.txt')))
    expect(errorVirtualPath(err)).toBe('/new.txt')
  })
})
