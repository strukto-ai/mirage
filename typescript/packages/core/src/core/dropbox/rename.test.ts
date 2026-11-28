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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PathSpec } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DropboxApiError } from './client.ts'
import { rename } from './rename.ts'

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

describe('dropbox rename conflict probe', () => {
  it('is bounded to one entry', async () => {
    // The probe is bounded, not a full listing: listFolder follows every
    // continuation cursor, so asking it with a small page size made one
    // request per child to answer a yes/no.
    await account.mkdir('/src')
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await account.put(`/dst/${name}`, new Uint8Array([107]))
    }
    await account.run.recordRequests()
    await expect(
      rename(account.accessor(), PathSpec.fromStrPath('/src'), PathSpec.fromStrPath('/dst')),
    ).rejects.toBeInstanceOf(DropboxApiError)
    const listed = await account.run.bodies('POST', '/2/files/list_folder')
    expect(listed.map((body) => (body as { limit?: number }).limit)).toEqual([1])
    expect(await account.run.bodies('POST', '/2/files/list_folder/continue')).toEqual([])
    expect(await account.run.bodies('POST', '/2/files/delete_v2')).toEqual([])
  })
})

const MOVE = '/2/files/move_v2'
const DELETE = '/2/files/delete_v2'
const LIST = '/2/files/list_folder'
const ENC = new TextEncoder()

function renamed(src: string, dst: string): Promise<void> {
  return rename(account.accessor(), PathSpec.fromStrPath(src), PathSpec.fromStrPath(dst))
}

// Run `change` while the `nth` move from now waits, then answer it with
// `status`.
async function atMove(nth: number, change: () => Promise<unknown>, status: number): Promise<void> {
  if (nth === 1) {
    await account.run.beforeNext([['POST', MOVE]], change, status)
    return
  }
  await account.run.beforeNext([['POST', MOVE]], () => atMove(nth - 1, change, status))
}

describe('dropbox rename onto a taken name', () => {
  it('sets the file aside, takes its name, then deletes it', async () => {
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.recordRequests()
    await renamed('/a.txt', '/b.txt')
    const moves = (await account.run.bodies('POST', MOVE)) as {
      from_path: string
      to_path: string
    }[]
    const pairs = moves.map((m) => [m.from_path, m.to_path])
    expect(pairs[0]).toEqual(['/a.txt', '/b.txt'])
    expect(pairs[1]?.[0]).toBe('/b.txt')
    expect(pairs[1]?.[1]).toMatch(/^\/b\.txt\.mirage-[0-9a-f]{32}$/)
    expect(pairs[2]).toEqual(['/a.txt', '/b.txt'])
    const deleted = (await account.run.bodies('POST', DELETE)) as { path: string }[]
    expect(deleted.map((body) => body.path)).toEqual([pairs[1]?.[1]])
    expect(await account.names()).toEqual(['b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('mine')
  })

  it('keeps the destination when moving it aside is refused', async () => {
    // The move meets the taken name first, then moving the file aside is
    // refused: nothing moved, so nothing is put back.
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.answerNext('POST', MOVE, 409, { error_summary: 'to/conflict/file/..' })
    await account.run.answerNext('POST', MOVE, 409, { error_summary: 'from_write/no_write/..' })
    await expect(renamed('/a.txt', '/b.txt')).rejects.toBeInstanceOf(DropboxApiError)
    expect(await account.names()).toEqual(['a.txt', 'b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('theirs')
  })

  it('moves the file back when the delete is refused', async () => {
    await account.put('/src/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.answerNext('POST', DELETE, 409, {
      error_summary: 'path_lookup/restricted_content/..',
    })
    await expect(renamed('/src/a.txt', '/b.txt')).rejects.toBeInstanceOf(DropboxApiError)
    expect(await account.names()).toEqual(['b.txt', 'src'])
    expect(await account.names('/src')).toEqual(['a.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('theirs')
  })

  it('keeps a folder given a child while the source moves', async () => {
    // Another client writes into the empty folder after the first probe,
    // while the source moves beside it (the move after that probe): the probe
    // made just before the delete sees the child, so the folder stays and the
    // source goes back.
    await account.put('/src/x.txt', ENC.encode('x'))
    await account.mkdir('/dst')
    await account.run.beforeNext([['POST', LIST]], () =>
      account.run.beforeNext([['POST', MOVE]], () =>
        account.put('/dst/late.txt', ENC.encode('late')),
      ),
    )
    await expect(renamed('/src', '/dst')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await account.names()).toEqual(['dst', 'src'])
    expect(await account.names('/dst')).toEqual(['late.txt'])
    expect(await account.names('/src')).toEqual(['x.txt'])
  })

  it('finishes a move whose landing went through', async () => {
    // The third move (the first met the taken name, the second set the file
    // there aside) lands, but its answer is lost: the moved file is found at
    // the name, and the file set aside is deleted.
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await atMove(
      3,
      () => account.run.call('POST', MOVE, { json: { from_path: '/a.txt', to_path: '/b.txt' } }),
      502,
    )
    await renamed('/a.txt', '/b.txt')
    expect(await account.names()).toEqual(['b.txt'])
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('mine')
  })

  it('leaves a landing another client wrote onto when the delete is refused', async () => {
    // Its rev moved on, so it stays at the name rather than going back with
    // that write.
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await account.run.beforeNext(
      [['POST', DELETE]],
      () => account.put('/b.txt', ENC.encode('later')),
      409,
    )
    await expect(renamed('/a.txt', '/b.txt')).rejects.toBeInstanceOf(DropboxApiError)
    expect(new TextDecoder().decode(await account.read('/b.txt'))).toBe('later')
    expect(await account.names()).not.toContain('a.txt')
  })
})
