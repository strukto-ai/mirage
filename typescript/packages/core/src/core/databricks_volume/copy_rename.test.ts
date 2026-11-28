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
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import {
  DatabricksVolume,
  DIRS,
  FILES,
  ROOT,
  spec,
} from '../../../tests/fixtures/databricks_volume.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { type FileStat, PathSpec } from '../../types.ts'
import { makeResolveGlob } from '../../utils/glob_walk.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { copy } from './copy.ts'
import { readdir as dbxReaddir } from './readdir.ts'
import { rename } from './rename.ts'
import { stat as dbxStat } from './stat.ts'

// The glob walk takes child paths; this backend lists rows.
async function listedPaths(accessor: DatabricksVolumeAccessor, path: PathSpec): Promise<string[]> {
  const base = path.virtual.replace(/\/$/, '')
  return ((await dbxReaddir(accessor, path)) as FileStat[]).map((row) => `${base}/${row.name}`)
}

const resolveGlob = (accessor: DatabricksVolumeAccessor, paths: PathSpec[]): Promise<PathSpec[]> =>
  makeResolveGlob(
    (path) => listedPaths(accessor, path),
    undefined,
    (path) => dbxStat(accessor, path),
  )(paths)

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
  await volume.run.close()
})

// Run `change` while the `nth` directory listing from now waits: each listing
// before it, held, arms the hold on the next.
async function whileListing(nth: number, change: () => Promise<void>): Promise<void> {
  await volume.run.beforeNext(
    [['GET', DIRS]],
    nth === 1 ? change : () => whileListing(nth - 1, change),
  )
}

/** The method of each request recorded, in order. */
async function methods(): Promise<string[]> {
  return (await volume.run.requests()).map((r) => r.split(' ')[0] ?? '')
}

describe('copy', () => {
  it('downloads then uploads file contents', async () => {
    await volume.put(`${ROOT}/a.txt`, 'hello')
    await volume.run.recordRequests()
    await copy(volume.accessor(), spec('/volume/a.txt'), spec('/volume/b.txt'))
    expect(await volume.asked('PUT', FILES)).toEqual([`${ROOT}/b.txt`])
    expect(await volume.run.params('PUT', FILES)).toEqual([{ overwrite: 'true' }])
    expect(await volume.content(`${ROOT}/b.txt`)).toBe('hello')
  })

  it('is a no-op for the same backend path', async () => {
    await volume.put(`${ROOT}/a.txt`, 'hello')
    await volume.run.recordRequests()
    await copy(volume.accessor(), spec('/volume/a.txt'), spec('/volume/a.txt'))
    expect((await methods()).filter((m) => m === 'PUT' || m === 'DELETE')).toHaveLength(0)
  })

  it('still raises for a missing source on same-path copy', async () => {
    const err = (await copy(
      volume.accessor(),
      spec('/volume/gone.txt'),
      spec('/volume/gone.txt'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it('refuses directories without recursive', async () => {
    await volume.mkdir(`${ROOT}/dir`)
    const err = (await copy(volume.accessor(), spec('/volume/dir'), spec('/volume/dir2')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('EISDIR')
  })

  it('copies trees recursively', async () => {
    await volume.put(`${ROOT}/dir/a.txt`, 'data')
    await volume.run.recordRequests()
    await copy(volume.accessor(), spec('/volume/dir'), spec('/volume/dir2'), true)
    expect(await volume.asked('PUT', DIRS)).toContain(`${ROOT}/dir2`)
    expect(await volume.asked('PUT', FILES)).toEqual([`${ROOT}/dir2/a.txt`])
    expect(await volume.content(`${ROOT}/dir2/a.txt`)).toBe('data')
  })

  it('refuses copying a directory into its own subtree before any write', async () => {
    await volume.mkdir(`${ROOT}/dir`)
    await volume.run.recordRequests()
    const err = (await copy(
      volume.accessor(),
      spec('/volume/dir'),
      spec('/volume/dir/sub'),
      true,
    ).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('into itself')
    expect((await methods()).filter((m) => m === 'PUT')).toHaveLength(0)
  })
})

describe('rename', () => {
  it('same-path rename is a no-op and never deletes (PR 142 guard)', async () => {
    await volume.put(`${ROOT}/a.txt`, 'hello')
    await volume.run.recordRequests()
    await rename(volume.accessor(), spec('/volume/a.txt'), spec('/volume/a.txt'))
    expect((await methods()).filter((m) => m === 'PUT' || m === 'DELETE')).toHaveLength(0)
    expect(await volume.content(`${ROOT}/a.txt`)).toBe('hello')
  })

  it('copies then unlinks for distinct paths', async () => {
    await volume.put(`${ROOT}/a.txt`, 'hello')
    await volume.run.recordRequests()
    await rename(volume.accessor(), spec('/volume/a.txt'), spec('/volume/b.txt'))
    const order = await methods()
    expect(order).toContain('PUT')
    expect(order).toContain('DELETE')
    expect(order.indexOf('DELETE')).toBeGreaterThan(order.indexOf('PUT'))
    expect(await volume.content(`${ROOT}/b.txt`)).toBe('hello')
    expect(await volume.has(`${ROOT}/a.txt`)).toBe(false)
  })

  it('raises for a missing source', async () => {
    const err = (await rename(
      volume.accessor(),
      spec('/volume/gone.txt'),
      spec('/volume/gone.txt'),
    ).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })

  it.each(['file', 'directory', 'replaced'])(
    'keeps an entry written after the copy: %s',
    async (late) => {
      // Only what the copy carried is deleted: an entry written under the
      // source since, or one replaced since its copy, stays there, and the
      // move is ENOTEMPTY rather than a loss. Another client writes it once
      // the copy is done, while the delete walk's listing of the source
      // waits: the copy lists the source, and `late` too when it is there.
      const dir = `${ROOT}/dir`
      if (late === 'replaced') await volume.mkdir(`${dir}/late`)
      await volume.put(`${dir}/a.txt`, 'data')
      await whileListing(late === 'replaced' ? 3 : 2, async () => {
        if (late === 'directory') {
          await volume.mkdir(`${dir}/late`)
          return
        }
        if (late === 'replaced') await volume.rmdir(`${dir}/late`)
        await volume.put(`${dir}/late`, 'late')
      })
      await volume.run.recordRequests()
      await expect(
        rename(volume.accessor(), spec('/volume/dir'), spec('/volume/dir2')),
      ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
      expect(await volume.asked('DELETE', FILES)).toEqual([`${dir}/a.txt`])
      expect(await volume.asked('DELETE', DIRS)).toEqual([])
      expect(await volume.has(`${dir}/late`)).toBe(true)
    },
  )

  it('refuses moving a directory into its own subtree and never deletes', async () => {
    await volume.mkdir(`${ROOT}/dir`)
    await volume.run.recordRequests()
    const err = (await rename(
      volume.accessor(),
      spec('/volume/dir'),
      spec('/volume/dir/sub'),
    ).catch((e: unknown) => e)) as Error
    expect(err.message).toContain('subdirectory of itself')
    expect((await methods()).filter((m) => m === 'PUT' || m === 'DELETE')).toHaveLength(0)
  })
})

describe('resolveGlob', () => {
  it('expands patterns against readdir output', async () => {
    await volume.put(`${ROOT}/a.md`, 'a')
    await volume.put(`${ROOT}/b.txt`, 'b')
    await volume.put(`${ROOT}/c.md`, 'c')
    const pattern = new PathSpec({
      virtual: '/volume/*.md',
      directory: '/volume/',
      pattern: '*.md',
      resolved: false,
      vfsPath: mountKey('/volume/*.md', '/volume'),
    })
    const resolved = await resolveGlob(volume.accessor(), [pattern])
    expect(resolved.map((p) => p.virtual)).toEqual(['/volume/a.md', '/volume/c.md'])
  })

  it('passes through resolved paths untouched', async () => {
    await volume.run.recordRequests()
    const plain = spec('/volume/a.txt')
    const resolved = await resolveGlob(volume.accessor(), [plain])
    expect(resolved).toEqual([plain])
    expect(await volume.run.requests()).toEqual([])
  })
})
