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
    vi.mocked(api.copyPath).mockResolvedValueOnce(undefined)
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

  it('lands beside the file, deletes it, then takes its name', async () => {
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.recordRequests()
    await copy(account.accessor(), PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt'))
    const copies = (await account.run.bodies('POST', '/2/files/copy_v2')) as { to_path: string }[]
    expect(copies[0]?.to_path).toBe('/b.txt')
    expect(copies[1]?.to_path).toMatch(/^\/b\.txt\.mirage-[0-9a-f]{32}$/)
    const named = (await account.run.bodies('POST', '/2/files/move_v2')) as { to_path: string }[]
    expect(named.map((body) => body.to_path)).toEqual(['/b.txt'])
    expect(await account.names()).toEqual(['a.txt', 'b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('mine')
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
