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
import type * as ObserveModule from '../../observe/context.ts'
import type * as CacheContextModule from '../../cache/context.ts'
import type * as DriveModule from '../google/drive.ts'
import type { DriveFile } from '../google/drive.ts'

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

vi.mock('../../cache/context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof CacheContextModule>()
  return {
    ...actual,
    invalidateAfterWrite: async (...args: Parameters<typeof actual.invalidateAfterWrite>) => {
      H.order.push('invalidate')
      await actual.invalidateAfterWrite(...args)
    },
  }
})

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import type { FakeDrive } from './_test_util.ts'
import { DOC_MIME, makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
  H.order = []
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive write', () => {
  it('creates a file in an existing parent', async () => {
    fake.folder('a')
    await write(accessor, spec('/a/new.txt'), ENC.encode('hello'))
    const item = fake.find('new.txt')
    expect(item).not.toBeNull()
    expect(DEC.decode(item?.content)).toBe('hello')
  })

  it('overwrites the same id', async () => {
    const id = fake.add('f.txt', 'root', undefined, ENC.encode('old'))
    await write(accessor, spec('/f.txt'), ENC.encode('new'))
    expect(DEC.decode(fake.items.get(id)?.content)).toBe('new')
    expect(fake.items.size).toBe(1)
  })

  it('missing parent raises ENOENT', async () => {
    await expect(write(accessor, spec('/no/f.txt'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('writing a folder raises EISDIR', async () => {
    fake.folder('d')
    await expect(write(accessor, spec('/d'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('writing a google-native file raises EACCES', async () => {
    fake.add('Report', 'root', DOC_MIME)
    await expect(write(accessor, spec('/Report.gdoc.json'), ENC.encode('x'))).rejects.toMatchObject(
      { code: 'EACCES' },
    )
  })
})

const HAPPY: Record<string, unknown> = {
  size: '5',
  md5Checksum: 'm5',
  headRevisionId: 'r5',
  mimeType: 'text/plain',
}

// [name, overrides on the fake's public() reply (null removes), expected
// fingerprint] for 5 written bytes. The literal tokens are ones no local hash
// produces.
const REPLY_ROWS: [string, Record<string, unknown>, string | null][] = [
  ['agrees', {}, 'm5'],
  ['no md5 takes the head revision', { md5Checksum: null }, 'r5'],
  ['no mimeType counts as non-native', { mimeType: null }, 'm5'],
]

function withOverrides(
  reply: DriveFile,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...reply }
  for (const [key, value] of Object.entries({ ...HAPPY, ...overrides })) {
    if (value === null) Reflect.deleteProperty(out, key)
    else out[key] = value
  }
  return out
}

function replyWith(build: (reply: DriveFile) => unknown): void {
  const upload = fake.uploadFile.bind(fake)
  const update = fake.updateFileContent.bind(fake)
  vi.spyOn(fake, 'uploadFile').mockImplementation(
    async (...args: Parameters<FakeDrive['uploadFile']>) => build(await upload(...args)) as never,
  )
  vi.spyOn(fake, 'updateFileContent').mockImplementation(
    async (...args: Parameters<FakeDrive['updateFileContent']>) =>
      build(await update(...args)) as never,
  )
}

async function writeRecorded(): Promise<unknown[][]> {
  const [, records] = await runWithRecording(() =>
    write(accessor, spec('/f.txt'), ENC.encode('hello')),
  )
  return records.map((r) => [r.op, r.path, r.bytes, r.fingerprint, r.revision])
}

describe.each([
  ['create', false],
  ['update', true],
])('gdrive write records the upload reply (%s)', (_kind, existing) => {
  beforeEach(() => {
    if (existing) fake.add('f.txt', 'root', undefined, ENC.encode('old'))
  })

  it.each(REPLY_ROWS)('%s', async (_name, overrides, token) => {
    replyWith((reply) => withOverrides(reply, overrides))
    expect(await writeRecorded()).toEqual([['write', '/f.txt', 5, token, null]])
    // Recorded before the eviction, so the record exists when the cache
    // reacts to the write.
    expect(H.order).toEqual(['record', 'invalidate'])
  })
})

it('a gdrive write whose reply fails still evicts the path', async () => {
  // Drive may have stored the bytes before the reply broke off, so the cached
  // copy is stale either way.
  vi.spyOn(fake, 'uploadFile').mockRejectedValue(new Error('reply cut off'))
  await expect(writeRecorded()).rejects.toThrow('reply cut off')
  expect(H.order).toEqual(['invalidate'])
})
