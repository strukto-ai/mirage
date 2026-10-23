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
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof DriveModule>()
  const faked: Record<string, unknown> = { ...actual }
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') faked[name] = vi.fn()
  }
  return faked
})

import { ByteSpool } from '../../io/spool.ts'
import type { ByteWindow } from '../../utils/ranges.ts'
import * as drive from '../google/drive.ts'
import { TOKEN_MANAGER } from '../../../tests/core/gdrive/_test_util.ts'
import { DriveClient, type DriveApi } from './api.ts'

const WINDOW: ByteWindow = { offset: 2, size: 4 }
const REVISION_WINDOW: ByteWindow = { offset: 7, size: null }
const BYTES = new Uint8Array([1, 2, 3])
const SPOOL = new ByteSpool()

interface Delegation {
  args: unknown[]
  wire: (...args: never[]) => unknown
  sent: unknown[]
  reply?: unknown
  returns?: unknown
}

const DELEGATIONS: { [K in keyof DriveApi]: Delegation & { args: Parameters<DriveApi[K]> } } = {
  listFiles: {
    args: [{ folderId: 'f1', driveId: 'd1', limit: 1 }],
    wire: drive.listFiles,
    sent: [{ folderId: 'f1', driveId: 'd1', limit: 1 }],
  },
  listChildren: {
    args: [['a', 'b'], 'd2'],
    wire: drive.listChildren,
    sent: [['a', 'b'], 'd2'],
  },
  listSharedDrives: { args: [], wire: drive.listSharedDrives, sent: [] },
  listAllFiles: {
    args: [{ mimeType: 'm', modifiedAfter: 'lo', modifiedBefore: 'hi' }],
    wire: drive.listAllFiles,
    sent: [{ mimeType: 'm', modifiedAfter: 'lo', modifiedBefore: 'hi' }],
  },
  searchFiles: {
    args: ['needle', ['p1', 'p2'], 'm'],
    wire: drive.searchFiles,
    sent: ['needle', ['p1', 'p2'], 'm'],
  },
  getFile: { args: ['f2', 'md5Checksum'], wire: drive.getFile, sent: ['f2', 'md5Checksum'] },
  storageQuota: { args: [], wire: drive.storageQuota, sent: [] },
  deleteFile: { args: ['f3'], wire: drive.deleteFile, sent: ['f3'] },
  downloadFile: { args: ['f4', WINDOW], wire: drive.downloadFile, sent: ['f4', WINDOW] },
  downloadFileStream: { args: ['f5'], wire: drive.downloadFileStream, sent: ['f5'] },
  createFolder: { args: ['dir', 'p3'], wire: drive.createFolder, sent: ['dir', 'p3'] },
  uploadFile: {
    args: ['a.txt', 'p4', BYTES],
    wire: drive.uploadFile,
    sent: ['a.txt', 'p4', BYTES],
  },
  updateFileContent: {
    args: ['f6', SPOOL],
    wire: drive.updateFileContent,
    sent: ['f6', SPOOL],
  },
  patchFile: {
    args: ['f7', { body: { name: 'b' }, addParents: 'p6', removeParents: 'p5' }],
    wire: drive.patchFile,
    sent: ['f7', { body: { name: 'b' }, addParents: 'p6', removeParents: 'p5' }],
  },
  copyFile: { args: ['f8', 'c.txt', 'p7'], wire: drive.copyFile, sent: ['f8', 'c.txt', 'p7'] },
  startPageToken: { args: [], wire: drive.startPageToken, sent: [] },
  listChanges: { args: ['t1'], wire: drive.listChanges, sent: ['t1'] },
  captureFileMetadata: {
    args: ['f9'],
    wire: drive.getFile,
    sent: ['f9', 'headRevisionId,md5Checksum'],
    reply: { id: 'f9', name: 'f', headRevisionId: 'r9', md5Checksum: 'abc' },
    returns: ['abc', 'r9'],
  },
  downloadRevision: {
    args: ['f10', 'r1', REVISION_WINDOW],
    wire: drive.downloadRevision,
    sent: ['f10', 'r1', REVISION_WINDOW],
  },
  downloadRevisionStream: {
    args: ['f11', 'r2'],
    wire: drive.downloadRevisionStream,
    sent: ['f11', 'r2'],
  },
}

describe('DriveClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(Object.entries<Delegation>(DELEGATIONS))(
    '%s sends its wire call the token manager and its arguments',
    async (method, row) => {
      const reply = 'reply' in row ? row.reply : Symbol(method)
      vi.mocked(row.wire).mockReturnValue(reply)
      const client = new DriveClient(TOKEN_MANAGER)
      const call = Reflect.get(client, method) as (...a: unknown[]) => unknown
      const answer = await call.apply(client, row.args)
      if ('returns' in row) expect(answer).toEqual(row.returns)
      else expect(answer).toBe(reply)
      expect(row.wire).toHaveBeenCalledTimes(1)
      expect(row.wire).toHaveBeenCalledWith(TOKEN_MANAGER, ...row.sent)
    },
  )

  it('captures a missing md5 or head revision as null', async () => {
    vi.mocked(drive.getFile).mockResolvedValue({ id: 'f1', name: 'f' })
    expect(await new DriveClient(TOKEN_MANAGER).captureFileMetadata('f1')).toEqual([null, null])
  })
})
