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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../google/client.ts'

vi.mock('../google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/client.ts')
  return { ...actual, googleGet: vi.fn() }
})

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import { runWithRecording, runWithRevisions } from '../../observe/context.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import * as client from '../google/client.ts'
import type { TokenManager } from '../google/client.ts'
import { checksum } from './checksum.ts'

const SCOPE = new PathSpec({ vfsPath: 'r.pdf', virtual: '/r.pdf', directory: '/' })
const accessor = new GDriveAccessor({
  tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
})

function row(resourceType: string): FileStat {
  return new FileStat({
    name: 'r.pdf',
    type: FileType.FILE,
    extra: { file_id: 'f1', resource_type: resourceType },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Drive checksum', () => {
  // Mirrors python's test_drive_answers_the_digest_it_keeps.
  it.each([
    ['md5', 'md5Checksum'],
    ['sha1', 'sha1Checksum'],
    ['sha256', 'sha256Checksum'],
  ])('answers the %s Drive keeps', async (algorithm, field) => {
    const reply = { md5Checksum: 'm5', headRevisionId: 'h1', [field]: 'ABC123' }
    vi.mocked(client.googleGet).mockResolvedValue(reply)
    const [found, records] = await runWithRecording(() =>
      checksum(accessor, SCOPE, algorithm, row('gdrive/file')),
    )
    expect(found).toBe('abc123')
    const params = vi.mocked(client.googleGet).mock.calls[0]?.[2] as { fields: string }
    const fields = params.fields.split(',')
    expect(fields[0]).toBe(field)
    expect(fields).toEqual(expect.arrayContaining(['md5Checksum', 'headRevisionId']))
    expect(records.map((r) => [r.op, r.path, r.fingerprint, r.revision])).toEqual([
      ['read', '/r.pdf', reply.md5Checksum, 'h1'],
    ])
  })

  // Mirrors python's test_a_native_file_or_another_algorithm_reads.
  it('reads a native file or another algorithm', async () => {
    expect(await checksum(accessor, SCOPE, 'md5', row('gdrive/gdoc'))).toBeNull()
    expect(await checksum(accessor, SCOPE, 'sha512', row('gdrive/file'))).toBeNull()
    expect(client.googleGet).not.toHaveBeenCalled()
  })

  // Mirrors python's test_a_pinned_revision_reads.
  it('reads a pinned revision', async () => {
    const found = await runWithRevisions(new Map([[SCOPE.virtual, 'r7']]), () =>
      checksum(accessor, SCOPE, 'md5', row('gdrive/file')),
    )
    expect(found).toBeNull()
    expect(client.googleGet).not.toHaveBeenCalled()
  })
})
