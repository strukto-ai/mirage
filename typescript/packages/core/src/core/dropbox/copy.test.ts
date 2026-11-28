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

import type * as PathsModule from './paths.ts'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof ApiModule>('./api.ts')
  return { ...actual, copyPath: vi.fn() }
})

import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { PathSpec } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import * as api from './api.ts'
import { DropboxApiError, type DropboxTokenManager } from './client.ts'
import { copy, dirCopy } from './copy.ts'

function makeAccessor(): DropboxAccessor {
  return new DropboxAccessor({ tokenManager: {} as DropboxTokenManager })
}

describe('dropbox dirCopy', () => {
  it('copies the tree in one request', async () => {
    vi.mocked(api.copyPath).mockResolvedValueOnce({})
    await dirCopy(makeAccessor(), PathSpec.fromStrPath('/src'), PathSpec.fromStrPath('/dst'))
    expect(vi.mocked(api.copyPath).mock.calls.at(-1)?.slice(1)).toEqual(['/src', '/dst'])
  })
})

describe('dropbox copy onto a taken name', () => {
  let origin: string
  let account: DropboxAccount
  const ENC = new TextEncoder()

  beforeAll(async () => {
    origin = await serve('dropbox')
  }, 30_000)

  beforeEach(async () => {
    account = new DropboxAccount(origin)
    // The file mocks copyPath for dirCopy; these cases copy on the fake.
    const actual = await vi.importActual<typeof ApiModule>('./api.ts')
    vi.mocked(api.copyPath).mockImplementation(actual.copyPath)
  })

  afterEach(async () => {
    await account.run.close()
  })

  it('sets the file aside, lands on its name, then deletes it', async () => {
    // The copy meets the taken name, so the file moves aside under a staged
    // name, the copy lands on its name, and the file set aside goes, held to
    // the rev its move answered.
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.recordRequests()
    await copy(account.accessor(), PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt'))
    const moves = (await account.run.bodies('POST', '/2/files/move_v2')) as {
      from_path: string
      to_path: string
    }[]
    expect(moves).toHaveLength(1)
    expect(moves[0]?.from_path).toBe('/b.txt')
    expect(moves[0]?.to_path).toMatch(/^\/b\.txt\.mirage-[0-9a-f]{32}$/)
    const copies = (await account.run.bodies('POST', '/2/files/copy_v2')) as { to_path: string }[]
    expect(copies.map((body) => body.to_path)).toEqual(['/b.txt', '/b.txt'])
    const deleted = (await account.run.bodies('POST', '/2/files/delete_v2')) as {
      path: string
      parent_rev?: string
    }[]
    expect(deleted.map((body) => body.path)).toEqual([moves[0]?.to_path])
    expect(deleted[0]?.parent_rev).toBeTruthy()
    expect(await account.names()).toEqual(['a.txt', 'b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('mine')
  })

  it('puts the file back when the landing is refused', async () => {
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.recordRequests()
    await account.run.answerNext('POST', '/2/files/copy_v2', 409, {
      error_summary: 'to/conflict/file/..',
    })
    await account.run.answerNext('POST', '/2/files/copy_v2', 409, {
      error_summary: 'from_lookup/restricted_content/..',
    })
    await expect(
      copy(account.accessor(), PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')),
    ).rejects.toBeInstanceOf(DropboxApiError)
    const moves = (await account.run.bodies('POST', '/2/files/move_v2')) as {
      from_path: string
      to_path: string
    }[]
    expect(moves.map((m) => [m.from_path, m.to_path])[1]).toEqual([moves[0]?.to_path, '/b.txt'])
    expect(await account.run.bodies('POST', '/2/files/delete_v2')).toEqual([])
    expect(await account.names()).toEqual(['a.txt', 'b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('theirs')
  })

  it('keeps a folder that took the name before it moved', async () => {
    // Another client swaps the file for a folder holding a child just before
    // the file moves aside: what moved is not the file read, so it moves back,
    // and nothing is deleted.
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.recordRequests()
    await account.run.beforeNext([['POST', '/2/files/move_v2']], async () => {
      await account.run.call('POST', '/2/files/delete_v2', { json: { path: '/b.txt' } })
      await account.put('/b.txt/child.txt', ENC.encode('child'))
    })
    await expect(
      copy(account.accessor(), PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    expect(await account.run.bodies('POST', '/2/files/delete_v2')).toEqual([])
    expect(await account.names()).toEqual(['a.txt', 'b.txt'])
    expect(await account.names('/b.txt')).toEqual(['child.txt'])
  })

  it('drops the copy when the delete is refused', async () => {
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.answerNext('POST', '/2/files/delete_v2', 409, {
      error_summary: 'path_lookup/restricted_content/..',
    })
    await expect(
      copy(account.accessor(), PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')),
    ).rejects.toBeInstanceOf(DropboxApiError)
    expect(await account.names()).toEqual(['a.txt', 'b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('theirs')
  })
})

vi.mock('./paths.ts', async (original) => ({
  ...(await original<typeof PathsModule>()),
  checkPath: vi.fn().mockResolvedValue(null),
}))
