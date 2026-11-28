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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { MEMORY_LIMIT, setSpoolFactory } from '../../io/spool.ts'
import {
  DatabricksVolume,
  DIRS,
  FILES,
  ROOT,
  spec,
} from '../../../tests/fixtures/databricks_volume.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DatabricksVolumeConfig } from '../../vfs/databricks_volume/config.ts'
import { parseConfigWithSchema } from '../../vfs/secrets.ts'
import { create } from './create.ts'
import { mkdir } from './mkdir.ts'
import { rmRecursive } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

let origin = ''
let volume: DatabricksVolume

beforeAll(async () => {
  origin = await serve('databricks')
})

beforeEach(async () => {
  volume = new DatabricksVolume(origin)
  await volume.reset()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  setSpoolFactory(null)
  await volume.run.close()
})

const ENC = new TextEncoder()

/** The `METHOD path` of the last request recorded. */
async function last(): Promise<string> {
  return (await volume.run.requests()).at(-1) ?? ''
}

describe('writeBytes', () => {
  it('PUTs with overwrite=true after checking the parent directory', async () => {
    await volume.mkdir(`${ROOT}/reports`)
    await volume.run.recordRequests()
    await write(volume.accessor(), spec('/volume/reports/a.txt'), ENC.encode('hi'))
    expect(await volume.asked('HEAD', DIRS)).toEqual([`${ROOT}/reports`])
    expect(await volume.asked('PUT', FILES)).toEqual([`${ROOT}/reports/a.txt`])
    expect(await volume.run.params('PUT', FILES)).toEqual([{ overwrite: 'true' }])
    expect(await volume.content(`${ROOT}/reports/a.txt`)).toBe('hi')
  })

  it('raises ENOENT when the parent directory is missing', async () => {
    const err = (await write(
      volume.accessor(),
      spec('/volume/missing/a.txt'),
      ENC.encode('x'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('raises ENOTDIR when the parent is a file', async () => {
    await volume.put(`${ROOT}/file.txt`, 'x')
    const err = (await write(
      volume.accessor(),
      spec('/volume/file.txt/a.txt'),
      ENC.encode('x'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOTDIR')
  })
})

describe('a large write', () => {
  // The body a request carries is seen only by a stubbed fetch: this one
  // checks the upload sends the spool's own body rather than a copy.
  it('goes up as the spool body, holding a bounded amount of memory', async () => {
    const spilled = new Blob()
    let stored = 0
    let largest = 0
    setSpoolFactory(() =>
      Promise.resolve({
        write: (_offset, part) => {
          stored += part.byteLength
          largest = Math.max(largest, part.byteLength)
          return Promise.resolve()
        },
        read: () => Promise.reject(new Error('the upload reads no window')),
        body: () => Promise.resolve(spilled),
        close: () => Promise.resolve(),
      }),
    )
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') bodies.push(init.body)
      return Promise.resolve(new Response(null, { status: 200 }))
    })
    const accessor = new DatabricksVolumeAccessor(
      parseConfigWithSchema(DatabricksVolumeConfig, {
        catalog: 'main',
        schema: 'default',
        volume: 'agent_files',
        root_path: '/root',
        host: 'https://dbc.example.com',
        token: 'tok-123',
      }),
    )
    const block = new Uint8Array(1024 * 1024)
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 64; i++) yield await Promise.resolve(block)
    }
    await write(accessor, spec('/volume/big.bin'), source())
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toBe(spilled)
    expect(stored).toBe(64 * block.byteLength)
    expect(largest).toBeLessThan(MEMORY_LIMIT)
  })

  it('past the PUT cap is refused before any request', async () => {
    vi.resetModules()
    vi.doMock('./client.ts', async (original) => ({
      ...(await original<Record<string, unknown>>()),
      MAX_UPLOAD_SIZE: 4,
    }))
    try {
      // From the module graph the cap was mocked into, so the write and
      // the accessor it takes agree.
      const { write: capped } = await import('./write.ts')
      const { DatabricksVolumeAccessor: Fresh } =
        await import('../../accessor/databricks_volume.ts')
      const { DatabricksVolumeConfig: FreshConfig } =
        await import('../../vfs/databricks_volume/config.ts')
      const { parseConfigWithSchema: freshParse } = await import('../../vfs/secrets.ts')
      const { PathSpec: FreshPath } = await import('../../types.ts')
      const { mountKey: freshKey } = await import('../../utils/key_prefix.ts')
      const accessor = new Fresh(freshParse(FreshConfig, volume.fields()))
      await volume.mkdir(ROOT)
      await volume.run.recordRequests()
      await expect(
        capped(
          accessor,
          FreshPath.fromStrPath('/volume/big.bin', freshKey('/volume/big.bin', '/volume')),
          ENC.encode('12345'),
        ),
      ).rejects.toMatchObject({ code: 'EFBIG', message: '/volume/big.bin' })
      expect(await volume.run.requests()).toEqual([])
    } finally {
      vi.doUnmock('./client.ts')
      vi.resetModules()
    }
  })
})

describe('create', () => {
  it('writes empty bytes', async () => {
    await volume.mkdir(ROOT)
    await create(volume.accessor(), spec('/volume/new.txt'))
    expect(await volume.content(`${ROOT}/new.txt`)).toBe('')
  })
})

describe('mkdir', () => {
  it('names the operand when the parent is missing', async () => {
    await volume.run.recordRequests()
    const err = (await mkdir(volume.accessor(), spec('/volume/missing/child')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
    expect(err.message).toBe('/volume/missing/child')
    expect(await volume.asked('PUT', DIRS)).toEqual([])
  })

  it('creates directories via PUT when parents=true', async () => {
    await volume.run.recordRequests()
    await mkdir(volume.accessor(), spec('/volume/a/b'), true)
    expect(await volume.run.requests()).toHaveLength(1)
    expect(await volume.asked('PUT', DIRS)).toEqual([`${ROOT}/a/b`])
    expect(await volume.has(`${ROOT}/a/b`)).toBe(true)
  })

  it('creates after parent check when target is missing', async () => {
    await volume.mkdir(ROOT)
    await volume.run.recordRequests()
    await mkdir(volume.accessor(), spec('/volume/newdir'))
    expect(await last()).toMatch(/^PUT \/api\/2\.0\/fs\/directories\//)
    expect(await volume.has(`${ROOT}/newdir`)).toBe(true)
  })
})

describe('unlink', () => {
  it('deletes files', async () => {
    await volume.put(`${ROOT}/a.txt`, 'x')
    await volume.run.recordRequests()
    await unlink(volume.accessor(), spec('/volume/a.txt'))
    expect(await last()).toMatch(/^DELETE \/api\/2\.0\/fs\/files\//)
    expect(await volume.has(`${ROOT}/a.txt`)).toBe(false)
  })

  it('refuses to delete directories', async () => {
    await volume.mkdir(`${ROOT}/dir`)
    const err = (await unlink(volume.accessor(), spec('/volume/dir')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('EISDIR')
  })
})

describe('rmdir', () => {
  it('rejects non-empty directories', async () => {
    await volume.put(`${ROOT}/dir/x.txt`, 'x')
    const err = (await rmdir(volume.accessor(), spec('/volume/dir')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTEMPTY')
  })

  it('refuses a child written after the listing', async () => {
    // The Files API deletes only an empty directory, so a child another
    // client writes while the delete waits refuses it.
    await volume.mkdir(`${ROOT}/empty`)
    await volume.run.beforeNext([['DELETE', DIRS]], () => volume.put(`${ROOT}/empty/late.txt`, 'x'))
    const err = (await rmdir(volume.accessor(), spec('/volume/empty')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOTEMPTY')
    expect(await volume.has(`${ROOT}/empty/late.txt`)).toBe(true)
  })

  it('deletes empty directories', async () => {
    await volume.mkdir(`${ROOT}/empty`)
    await volume.run.recordRequests()
    await rmdir(volume.accessor(), spec('/volume/empty'))
    expect(await last()).toMatch(/^DELETE \/api\/2\.0\/fs\/directories\//)
    expect(await volume.has(`${ROOT}/empty`)).toBe(false)
  })
})

describe('rmRecursive', () => {
  it('removes children before parents and returns virtual paths', async () => {
    await volume.put(`${ROOT}/dir/a.txt`, 'a')
    await volume.put(`${ROOT}/dir/sub/b.txt`, 'b')
    await volume.run.recordRequests()
    const removed = await rmRecursive(volume.accessor(), spec('/volume/dir'))
    expect(removed).toEqual(['/dir/a.txt', '/dir/sub/b.txt', '/dir/sub', '/dir'])
    const deletes = (await volume.run.requests()).filter((r) => r.startsWith('DELETE '))
    expect(deletes).toHaveLength(4)
    expect(deletes.at(-1)).toContain('/fs/directories/')
  })

  it('keeps a file written during the walk and refuses the removal', async () => {
    // The Files API deletes only an empty directory: a file another client
    // writes while the walk's first delete waits refuses it, and the
    // removal is ENOTEMPTY.
    await volume.put(`${ROOT}/dir/a.txt`, 'a')
    await volume.run.beforeNext([['DELETE', FILES]], () =>
      volume.put(`${ROOT}/dir/late.txt`, 'late'),
    )
    await expect(rmRecursive(volume.accessor(), spec('/volume/dir'))).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
    expect(await volume.content(`${ROOT}/dir/late.txt`)).toBe('late')
  })

  it('unlinks plain files', async () => {
    await volume.put(`${ROOT}/a.txt`, 'hello')
    await volume.run.recordRequests()
    const removed = await rmRecursive(volume.accessor(), spec('/volume/a.txt'))
    expect(removed).toEqual(['/a.txt'])
    expect(await last()).toMatch(/^DELETE /)
  })
})
