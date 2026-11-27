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

import { recordingScope } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { md5Hex } from '../../utils/hash.ts'
import { handedAt } from '../../../tests/workspace/fixtures/handed.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount, UPLOAD, UPLOAD_FILE } from '../../../tests/core/google/account.ts'
import { readdir } from './readdir.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()
const DOC_MIME = 'application/vnd.google-apps.document'
const HELLO_MD5 = md5Hex(ENC.encode('hello'))

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
  H.order = []
})

afterEach(async () => {
  await account.run.close()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

async function written(path: string, data: string): Promise<void> {
  const accessor = account.driveAccessor()
  await write(accessor, spec(path), ENC.encode(data), await handedAt(readdir, accessor, spec(path)))
}

describe('gdrive write', () => {
  it('lands on the file at the path now', async () => {
    // The listing named a.txt; another client then renamed that file to b.txt
    // and made a new a.txt. The write goes to the new a.txt.
    const moved = await account.upload('a.txt', 'old')
    const accessor = account.driveAccessor()
    const listed = await handedAt(readdir, accessor, spec('/a.txt'))
    await account.patch(moved, { name: 'b.txt' })
    const made = await account.upload('a.txt', 'other')
    await write(accessor, spec('/a.txt'), ENC.encode('new'), listed)
    expect(await account.content(made)).toBe('new')
    expect(await account.content(moved)).toBe('old')
  })

  it('creates a file in an existing parent', async () => {
    await account.folder('a')
    await written('/a/new.txt', 'hello')
    const item = await account.find('new.txt')
    expect(item).not.toBeNull()
    expect(await account.content(item?.id ?? '')).toBe('hello')
  })

  it('overwrites the same id', async () => {
    const id = await account.upload('f.txt', 'old')
    await written('/f.txt', 'new')
    expect(await account.content(id)).toBe('new')
    expect(await account.items()).toHaveLength(1)
  })

  it('missing parent raises ENOENT', async () => {
    await expect(written('/no/f.txt', 'x')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writing a folder raises EISDIR', async () => {
    await account.folder('d')
    await expect(written('/d', 'x')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('writing a google-native file raises EACCES', async () => {
    await account.create('Report', DOC_MIME)
    await expect(written('/Report.gdoc.json', 'x')).rejects.toMatchObject({ code: 'EACCES' })
  })
})

// [name, the fields Drive's answer to the write leaves out, the token it is
// recorded under] for 5 written bytes.
const REPLY_ROWS: [string, string[], 'md5' | 'revision'][] = [
  ['agrees', [], 'md5'],
  ['no md5 takes the head revision', ['md5Checksum'], 'revision'],
  ['no mimeType counts as non-native', ['mimeType'], 'md5'],
]

async function writeRecorded(): Promise<unknown[][]> {
  const accessor = account.driveAccessor()
  const handed = await handedAt(readdir, accessor, spec('/f.txt'))
  const [, records] = await recordingScope(() =>
    write(accessor, spec('/f.txt'), ENC.encode('hello'), handed),
  )
  return records.map((r) => [r.op, r.path, r.bytes, r.fingerprint, r.revision])
}

describe.each([
  ['create', false],
  ['update', true],
])('gdrive write records the upload reply (%s)', (_kind, existing) => {
  it.each(REPLY_ROWS)('%s', async (_name, dropped, token) => {
    if (existing) await account.upload('f.txt', 'old')
    // Drive's answer for a file holding these five bytes, kept elsewhere,
    // answered for the write with the fields the row drops left out.
    const model = await account.item(
      await account.upload('f.txt', 'hello', await account.folder('elsewhere')),
    )
    if (dropped.length > 0) {
      const reply = Object.fromEntries(
        Object.entries(model).filter(([key]) => !dropped.includes(key)),
      )
      await account.run.answerNext(
        existing ? 'PATCH' : 'POST',
        existing ? UPLOAD_FILE : UPLOAD,
        200,
        reply as never,
      )
    }
    const expected = token === 'md5' ? HELLO_MD5 : model.headRevisionId
    expect(await writeRecorded()).toEqual([['write', '/f.txt', 5, expected, null]])
    // Recorded before the eviction, so the record exists when the cache
    // reacts to the write.
    expect(H.order).toEqual(['record'])
  })
})

it('a gdrive write whose reply is empty still records it', async () => {
  // The upload landed, so the write counts even without a token: an earlier
  // write's claim on the path must not win.
  await account.run.answerNext('POST', UPLOAD, 200, new Uint8Array(0))
  expect(await writeRecorded()).toEqual([['write', '/f.txt', 5, null, null]])
})
