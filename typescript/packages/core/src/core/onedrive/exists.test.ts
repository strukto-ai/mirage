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

import { runInCommandScope } from '../../cache/index/scope.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { type FileStat, MountMode, PathSpec } from '../../types.ts'
import { OneDriveVFS } from '../../vfs/onedrive/onedrive.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { exists } from './exists.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OneDrive exists', () => {
  it('answers a listed name from the mount without a request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ value: [{ id: '1', name: 'a.txt', size: 1, file: {} }] })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const vfs = new OneDriveVFS({ accessToken: 'token' })
    const ws = new Workspace(
      { '/od/': vfs },
      { mode: MountMode.READ, shellParser: await getTestParser() },
    )
    try {
      // One command lists and stats, so its own listing proves b.txt absent.
      await runInCommandScope(async () => {
        await ws.dispatch('readdir', '/od')
        expect(((await ws.dispatch('stat', '/od/a.txt')) as FileStat).name).toBe('a.txt')
        await expect(ws.dispatch('stat', '/od/b.txt')).rejects.toMatchObject({ code: 'ENOENT' })
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      await ws.close()
    }
  })

  it('asks Graph for a name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) =>
        Promise.resolve(
          String(url).endsWith('/root:/a.txt')
            ? new Response(JSON.stringify({ id: '1', name: 'a.txt', size: 1, file: {} }))
            : new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 }),
        ),
      ),
    )
    const accessor = new OneDriveAccessor({ accessToken: 'token' })
    expect(await exists(accessor, PathSpec.fromStrPath('/od/a.txt', 'a.txt'))).toBe(true)
    expect(await exists(accessor, PathSpec.fromStrPath('/od/b.txt', 'b.txt'))).toBe(false)
  })
})
