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
import type * as ObserveModule from '../../observe/context.ts'

const H = vi.hoisted(() => ({
  order: [] as string[],
}))

vi.mock('../../observe/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ObserveModule>()
  return {
    ...actual,
    record: (...args: Parameters<typeof actual.record>) => {
      H.order.push('record')
      actual.record(...args)
    },
  }
})

import { runWithWriteContext, writeCondition } from '../../cache/context.ts'
import { recordingScope } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DropboxApiError } from './client.ts'
import { copy } from './copy.ts'
import { create } from './create.ts'
import { exists } from './exists.ts'
import { mkdir } from './mkdir.ts'
import { rename } from './rename.ts'
import { rmR } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { replace, write } from './write.ts'

const ENC = new TextEncoder()
const UPLOAD_ROUTE = '/2/files/upload'
const METADATA_ROUTE = '/2/files/get_metadata'
const CREATE_ROUTE = '/2/files/create_folder_v2'
const DELETE_ROUTE = '/2/files/delete_v2'

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

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('dropbox write', () => {
  it('refuses a create-only write it cannot condition', async () => {
    await account.run.recordRequests()
    await expect(
      replace(account.accessor(), {
        path: spec('/new.txt'),
        body: ENC.encode('ours'),
        condition: { kind: 'absent' },
      }),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    expect(await account.run.bodies('POST', UPLOAD_ROUTE)).toEqual([])
    expect(await account.names()).toEqual([])
  })

  it('commits the explicit condition instead of the ambient cached version', async () => {
    const listed = await account.put('/a.txt', ENC.encode('hello'))
    const path = spec('/a.txt')
    async function* body(): AsyncGenerator<Uint8Array> {
      expect(await writeCondition(path, 'put')).toEqual({ kind: 'match', version: 'cached' })
      yield ENC.encode('ours')
    }
    await runWithWriteContext(
      '/',
      {
        vfs: 'dropbox',
        conditions: ['put'],
        readVersion: () => Promise.resolve('cached'),
        readVersions: (paths) => Promise.resolve(paths.map(() => 'cached')),
        drop: () => Promise.resolve(),
        keep: () => Promise.resolve(),
      },
      async () => {
        await replace(account.accessor(), {
          path,
          body: body(),
          condition: { kind: 'match', version: listed.content_hash },
        })
        expect(await writeCondition(path, 'put')).toEqual({ kind: 'match', version: 'cached' })
      },
    )
    expect(text(await account.read('/a.txt'))).toBe('ours')
  })

  // The path's spelling and the check both read the metadata Dropbox gave
  // just before another client's upload landed. The upload names the rev that
  // answer gave, so Dropbox refuses it and keeps the newer bytes.
  it('names the rev it checked', async () => {
    const before = await account.put('/a.txt', ENC.encode('hello'))
    await account.put('/a.txt', ENC.encode('later'))
    await account.run.answerNext('POST', METADATA_ROUTE, 200, before, 2)
    await account.run.recordRequests('dropbox-api-arg')
    await expect(
      replace(account.accessor(), {
        path: spec('/a.txt'),
        body: ENC.encode('ours'),
        condition: { kind: 'match', version: before.content_hash },
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })
    const sent = await account.run.headers('POST', UPLOAD_ROUTE)
    expect(sent).toHaveLength(1)
    expect((JSON.parse(sent[0]?.['dropbox-api-arg'] ?? '{}') as { mode: unknown }).mode).toEqual({
      '.tag': 'update',
      update: before.rev,
    })
    expect(text(await account.read('/a.txt'))).toBe('later')
  })

  it('closes an already-started body when create-only is unsupported', async () => {
    const chunk = new Uint8Array([9])
    let closed = false
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield await Promise.resolve(chunk)
        yield chunk
      } finally {
        closed = true
      }
    }
    const body = source()
    await body.next()
    await account.run.recordRequests()
    await expect(
      replace(account.accessor(), { path: spec('/a.txt'), body, condition: { kind: 'absent' } }),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    expect(closed).toBe(true)
    expect(await account.run.bodies('POST', UPLOAD_ROUTE)).toEqual([])
  })

  it('uploads through the subfolder mount root', async () => {
    await account.mkdir('/Team/data')
    await write(account.accessor('/Team/data'), spec('/note.txt'), new Uint8Array([104]))
    expect(text(await account.read('/Team/data/note.txt'))).toBe('h')
  })

  // Dropbox-API-Arg is a header, so a name past ASCII travels escaped.
  it('writes a path past ASCII', async () => {
    await write(account.accessor(), spec('/你好.txt'), ENC.encode('hi'))
    expect(await account.names()).toEqual(['你好.txt'])
    expect(text(await account.read('/你好.txt'))).toBe('hi')
  })

  it('creates a file of no bytes', async () => {
    await create(account.accessor(), spec('/new.txt'))
    expect(await account.read('/new.txt')).toEqual(new Uint8Array(0))
  })
})

describe('dropbox mkdir', () => {
  it('creates a folder when the parent exists', async () => {
    await mkdir(account.accessor(), spec('/docs'))
    expect(await account.names()).toEqual(['docs'])
  })

  // The create is sent and Dropbox's conflict is the answer: the only
  // lookup is the path spelling check every op makes.
  it('reads a conflict on the create as EEXIST, with no lookup first', async () => {
    await account.mkdir('/docs')
    await account.run.recordRequests()
    await expect(mkdir(account.accessor(), spec('/docs'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await account.run.bodies('POST', CREATE_ROUTE)).toEqual([
      expect.objectContaining({ path: '/docs' }),
    ])
  })

  it('is idempotent for an existing dir with parents', async () => {
    await account.mkdir('/docs')
    await account.run.recordRequests()
    await mkdir(account.accessor(), spec('/docs'), true)
    expect(await account.run.bodies('POST', CREATE_ROUTE)).toEqual([])
  })

  it('rejects a missing parent without parents', async () => {
    await account.run.recordRequests()
    await expect(mkdir(account.accessor(), spec('/a/b'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await account.run.bodies('POST', CREATE_ROUTE)).toEqual([])
  })
})

describe('dropbox unlink', () => {
  it('deletes a file', async () => {
    await account.put('/a.txt', ENC.encode('a'))
    await unlink(account.accessor(), spec('/a.txt'))
    expect(await account.names()).toEqual([])
  })

  it('refuses a folder with EISDIR', async () => {
    await account.mkdir('/docs')
    await expect(unlink(account.accessor(), spec('/docs'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(await account.names()).toEqual(['docs'])
  })

  it('refuses a missing path with ENOENT', async () => {
    await expect(unlink(account.accessor(), spec('/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('dropbox rmdir', () => {
  it('fails ENOTEMPTY instead of recursively deleting', async () => {
    await account.put('/docs/a.txt', ENC.encode('a'))
    await expect(rmdir(account.accessor(), spec('/docs'))).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
    expect(await account.names('/docs')).toEqual(['a.txt'])
  })

  it('removes an empty folder', async () => {
    await account.mkdir('/docs')
    await rmdir(account.accessor(), spec('/docs'))
    expect(await account.names()).toEqual([])
  })

  it('refuses a file with ENOTDIR', async () => {
    await account.put('/a.txt', ENC.encode('a'))
    await expect(rmdir(account.accessor(), spec('/a.txt'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

describe('dropbox rmR', () => {
  it('deletes recursively in one call', async () => {
    await account.put('/docs/sub/a.txt', ENC.encode('a'))
    await account.run.recordRequests()
    await rmR(account.accessor(), spec('/docs'))
    expect(await account.run.bodies('POST', DELETE_ROUTE)).toEqual([{ path: '/docs' }])
    expect(await account.names()).toEqual([])
  })

  it('maps a missing path to ENOENT', async () => {
    await expect(rmR(account.accessor(), spec('/ghost'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('dropbox rename', () => {
  it('replaces an existing destination file like GNU mv', async () => {
    await account.put('/a.txt', ENC.encode('mine'))
    await account.put('/b.txt', ENC.encode('theirs'))
    await rename(account.accessor(), spec('/a.txt'), spec('/b.txt'))
    expect(await account.names()).toEqual(['b.txt'])
    expect(text(await account.read('/b.txt'))).toBe('mine')
  })

  it('replaces an empty dir destination like rename(2)', async () => {
    await account.put('/src/x.txt', ENC.encode('x'))
    await account.mkdir('/dst')
    await rename(account.accessor(), spec('/src'), spec('/dst'))
    expect(await account.names()).toEqual(['dst'])
    expect(await account.names('/dst')).toEqual(['x.txt'])
  })

  it('keeps the error for a non-empty dir destination', async () => {
    await account.mkdir('/src')
    await account.put('/dst/keep.txt', ENC.encode('k'))
    await expect(rename(account.accessor(), spec('/src'), spec('/dst'))).rejects.toBeInstanceOf(
      DropboxApiError,
    )
    expect(await account.names()).toEqual(['dst', 'src'])
    expect(await account.names('/dst')).toEqual(['keep.txt'])
  })

  it('maps a missing source to ENOENT', async () => {
    await expect(rename(account.accessor(), spec('/ghost'), spec('/b'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('dropbox copy', () => {
  it('copies server-side under the mount root', async () => {
    await account.put('/Team/a.txt', ENC.encode('a'))
    await copy(account.accessor('/Team'), spec('/a.txt'), spec('/b.txt'))
    expect(text(await account.read('/Team/b.txt'))).toBe('a')
    expect(await account.names('/Team')).toEqual(['a.txt', 'b.txt'])
  })
})

describe('dropbox exists', () => {
  it('is true for the mount root without an API call', async () => {
    await account.run.recordRequests()
    expect(await exists(account.accessor(), spec('/'))).toBe(true)
    expect(await account.run.requests()).toEqual([])
  })

  it('maps 409 to false', async () => {
    expect(await exists(account.accessor(), spec('/ghost'))).toBe(false)
  })

  it('maps a found path to true', async () => {
    await account.put('/a.txt', ENC.encode('a'))
    expect(await exists(account.accessor(), spec('/a.txt'))).toBe(true)
  })
})

describe('dropbox write records the upload reply', () => {
  beforeEach(() => {
    H.order = []
  })

  // Dropbox's own upload reply with its content_hash replaced by 'h5', a
  // token no local hash produces; or a reply with no body.
  it.each([
    ['agrees', 'h5'],
    ['empty reply', null],
  ])('records the reply token (%s)', async (_name, token) => {
    const reply = await account.put('/other.txt', ENC.encode('hello'))
    await account.run.answerNext(
      'POST',
      UPLOAD_ROUTE,
      200,
      token === null ? null : { ...reply, content_hash: token },
    )
    H.order = []
    const [, records] = await recordingScope(() =>
      write(account.accessor(), spec('/note.txt'), ENC.encode('hello')),
    )
    expect(records.map((r) => [r.op, r.path, r.bytes, r.fingerprint, r.revision])).toEqual([
      ['write', '/note.txt', 5, token, null],
    ])
    // Recorded before the eviction, so the record exists when the cache
    // reacts to the write.
    expect(H.order).toEqual(['record'])
  })
})
