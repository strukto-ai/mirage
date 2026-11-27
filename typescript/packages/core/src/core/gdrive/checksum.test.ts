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
import { currentCaller, bindCaller } from '../../context/session_context.ts'
import { recordingScope } from '../../observe/context.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { FILE, GoogleAccount } from '../../../tests/core/google/account.ts'
import { checksum } from './checksum.ts'

const SCOPE = new PathSpec({ vfsPath: 'r.pdf', virtual: '/r.pdf', directory: '/' })
const DATA = 'report bytes'

let origin: string
let account: GoogleAccount

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(() => {
  account = new GoogleAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function row(fileId: string, resourceType: string): FileStat {
  return new FileStat({
    name: 'r.pdf',
    type: FileType.FILE,
    extra: { file_id: fileId, resource_type: resourceType },
  })
}

describe('Drive checksum', () => {
  // Mirrors python's test_drive_answers_the_digest_it_keeps.
  it.each([
    ['md5', 'md5Checksum'],
    ['sha1', 'sha1Checksum'],
    ['sha256', 'sha256Checksum'],
  ])('answers the %s Drive keeps', async (algorithm, field) => {
    const made = await account.upload('r.pdf', DATA)
    // Drive's digest in capitals, which the answer lowers.
    const answered = await account.item(made)
    answered[field] = (answered[field] as string).toUpperCase()
    await account.run.answerNext('GET', FILE, 200, answered)
    await account.run.recordRequests()
    const [found, records] = await recordingScope(() =>
      checksum(account.driveAccessor(), SCOPE, algorithm, row(made, 'gdrive/file')),
    )
    expect(found).toBe(createHash(algorithm).update(DATA).digest('hex'))
    expect((await account.log()).map(([name]) => name)).toEqual(['get'])
    const fields = ((await account.run.params('GET', FILE))[0]?.fields ?? '').split(',')
    expect(fields[0]).toBe(field)
    expect(fields).toEqual(expect.arrayContaining(['md5Checksum', 'headRevisionId']))
    expect(records.map((r) => [r.op, r.path, r.fingerprint, r.revision])).toEqual([
      ['read', '/r.pdf', answered.md5Checksum, answered.headRevisionId],
    ])
  })

  // Mirrors python's test_a_native_file_or_another_algorithm_reads.
  it('reads a native file or another algorithm', async () => {
    const made = await account.upload('r.pdf', DATA)
    const accessor = account.driveAccessor()
    await account.run.recordRequests()
    expect(await checksum(accessor, SCOPE, 'md5', row(made, 'gdrive/gdoc'))).toBeNull()
    expect(await checksum(accessor, SCOPE, 'sha512', row(made, 'gdrive/file'))).toBeNull()
    expect(await account.log()).toEqual([])
  })

  // Mirrors python's test_a_pinned_revision_reads.
  it('reads a pinned revision', async () => {
    const made = await account.upload('r.pdf', DATA)
    const accessor = account.driveAccessor()
    await account.run.recordRequests()
    const found = await bindCaller(
      { ...currentCaller(), revisions: { map: new Map([[SCOPE.virtual, 'r7']]) } },
      () => checksum(accessor, SCOPE, 'md5', row(made, 'gdrive/file')),
    )
    expect(found).toBeNull()
    expect(await account.log()).toEqual([])
  })
})
