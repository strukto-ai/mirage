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

import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { recordingScope } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { BoxAccount } from '../../../tests/core/box/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { checksum } from './checksum.ts'
import { readdir } from './readdir.ts'

const ENC = new TextEncoder()
const SCOPE = new PathSpec({ vfsPath: 'a.txt', virtual: '/a.txt', directory: '/' })
const FILE_ROUTE = '/2.0/files/:file_id'

let origin: string
let account: BoxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('box')
}, 30_000)

beforeEach(() => {
  account = new BoxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

// /a.txt and its entry as a listing gave it while it held "hello", after
// another client has since made it `now`.
async function listedThenChanged(now?: string): Promise<[string, FileStat | null]> {
  const id = await account.put('a.txt', ENC.encode('hello'))
  const entry = await entryAt(readdir, account.accessor(), SCOPE)
  if (now !== undefined) await account.uploadVersion(id, ENC.encode(now))
  return [id, entry]
}

describe('Box checksum', () => {
  // Mirrors python's test_box_answers_its_live_sha1: Box's own answer for
  // the file now, in upper case.
  it('answers its live sha1', async () => {
    const [id, entry] = await listedThenChanged('world')
    const live = await account.fileInfo(id)
    await account.run.answerNext('GET', FILE_ROUTE, 200, {
      ...live,
      sha1: (live.sha1 as string).toUpperCase(),
    })
    await account.run.recordRequests()
    expect(await checksum(account.accessor(), SCOPE, 'sha1', entry)).toBe(sha1('world'))
    expect(await account.run.requests()).toEqual([`GET /2.0/files/${id}`])
  })

  // Mirrors python's test_box_without_a_sha1_reads.
  it.each([null, ''])('reads a file whose sha1 is %j', async (gone) => {
    const [id, entry] = await listedThenChanged()
    const live = await account.fileInfo(id)
    await account.run.answerNext('GET', FILE_ROUTE, 200, { ...live, sha1: gone })
    expect(await checksum(account.accessor(), SCOPE, 'sha1', entry)).toBeNull()
  })

  // Mirrors python's test_box_keeps_no_md5.
  it('keeps no md5', async () => {
    const [, entry] = await listedThenChanged()
    await account.run.recordRequests()
    expect(await checksum(account.accessor(), SCOPE, 'md5', entry)).toBeNull()
    expect(await account.run.requests()).toEqual([])
  })

  // Mirrors python's test_box_records_the_token_a_read_would.
  it.each([
    ['as listed', undefined, sha1('hello')],
    ['changed since', 'world', null],
  ])('records the token a read would, %s', async (_name, now, token) => {
    const [, entry] = await listedThenChanged(now)
    const [, records] = await recordingScope(() =>
      checksum(account.accessor(), SCOPE, 'sha1', entry),
    )
    expect(records.map((r) => [r.op, r.path, r.fingerprint])).toEqual([['read', '/a.txt', token]])
  })
})
