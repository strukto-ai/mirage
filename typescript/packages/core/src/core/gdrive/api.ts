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

import type { ByteSpool } from '../../io/spool.ts'
import type { ByteWindow } from '../../utils/ranges.ts'
import type { TokenManager } from '../google/client.ts'
import * as drive from '../google/drive.ts'
import type { DriveChange, DriveFile, SharedDrive } from '../google/drive.ts'

/**
 * Every Drive request the Google backends make, as one object. A core op
 * reaches Drive only through `accessor.drive`. Mirrors Python's `DriveApi`.
 */
export interface DriveApi {
  listFiles(opts: {
    folderId: string
    driveId?: string | null
    limit?: number
  }): Promise<DriveFile[]>
  listChildren(folderIds: readonly string[], driveId: string | null): Promise<DriveFile[]>
  listSharedDrives(): Promise<SharedDrive[]>
  listAllFiles(opts?: {
    mimeType?: string | null
    modifiedAfter?: string | null
    modifiedBefore?: string | null
  }): Promise<{ files: DriveFile[]; complete: boolean }>
  searchFiles(
    text: string,
    parentIds: readonly string[],
    mimeType?: string | null,
  ): Promise<{ ids: string[]; complete: boolean }>
  getFile(fileId: string, fields?: string): Promise<DriveFile>
  storageQuota(): Promise<{ limit?: string; usage?: string }>
  deleteFile(fileId: string): Promise<void>
  downloadFile(fileId: string, window?: ByteWindow): Promise<Uint8Array>
  downloadFileStream(fileId: string): AsyncGenerator<Uint8Array, void>
  createFolder(name: string, parentId: string): Promise<DriveFile>
  uploadFile(name: string, parentId: string, data: Uint8Array | ByteSpool): Promise<DriveFile>
  updateFileContent(fileId: string, data: Uint8Array | ByteSpool): Promise<DriveFile>
  patchFile(
    fileId: string,
    opts: { body: Record<string, unknown>; addParents?: string; removeParents?: string },
  ): Promise<DriveFile>
  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile>
  startPageToken(): Promise<string>
  listChanges(pageToken: string): Promise<[DriveChange[], string]>
  captureFileMetadata(fileId: string): Promise<[string | null, string | null]>
  downloadRevision(fileId: string, revisionId: string, window?: ByteWindow): Promise<Uint8Array>
  downloadRevisionStream(fileId: string, revisionId: string): AsyncGenerator<Uint8Array, void>
}

/** The live `DriveApi`: one token manager, one wire call per method. */
export class DriveClient implements DriveApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  listFiles(opts: {
    folderId: string
    driveId?: string | null
    limit?: number
  }): Promise<DriveFile[]> {
    return drive.listFiles(this.tokenManager, opts)
  }

  listChildren(folderIds: readonly string[], driveId: string | null): Promise<DriveFile[]> {
    return drive.listChildren(this.tokenManager, folderIds, driveId)
  }

  listSharedDrives(): Promise<SharedDrive[]> {
    return drive.listSharedDrives(this.tokenManager)
  }

  listAllFiles(
    opts: {
      mimeType?: string | null
      modifiedAfter?: string | null
      modifiedBefore?: string | null
    } = {},
  ): Promise<{ files: DriveFile[]; complete: boolean }> {
    return drive.listAllFiles(this.tokenManager, opts)
  }

  searchFiles(
    text: string,
    parentIds: readonly string[],
    mimeType: string | null = null,
  ): Promise<{ ids: string[]; complete: boolean }> {
    return drive.searchFiles(this.tokenManager, text, parentIds, mimeType)
  }

  getFile(fileId: string, fields?: string): Promise<DriveFile> {
    return drive.getFile(this.tokenManager, fileId, fields)
  }

  storageQuota(): Promise<{ limit?: string; usage?: string }> {
    return drive.storageQuota(this.tokenManager)
  }

  deleteFile(fileId: string): Promise<void> {
    return drive.deleteFile(this.tokenManager, fileId)
  }

  downloadFile(fileId: string, window?: ByteWindow): Promise<Uint8Array> {
    return drive.downloadFile(this.tokenManager, fileId, window)
  }

  downloadFileStream(fileId: string): AsyncGenerator<Uint8Array, void> {
    return drive.downloadFileStream(this.tokenManager, fileId)
  }

  createFolder(name: string, parentId: string): Promise<DriveFile> {
    return drive.createFolder(this.tokenManager, name, parentId)
  }

  uploadFile(name: string, parentId: string, data: Uint8Array | ByteSpool): Promise<DriveFile> {
    return drive.uploadFile(this.tokenManager, name, parentId, data)
  }

  updateFileContent(fileId: string, data: Uint8Array | ByteSpool): Promise<DriveFile> {
    return drive.updateFileContent(this.tokenManager, fileId, data)
  }

  patchFile(
    fileId: string,
    opts: { body: Record<string, unknown>; addParents?: string; removeParents?: string },
  ): Promise<DriveFile> {
    return drive.patchFile(this.tokenManager, fileId, opts)
  }

  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile> {
    return drive.copyFile(this.tokenManager, fileId, name, parentId)
  }

  startPageToken(): Promise<string> {
    return drive.startPageToken(this.tokenManager)
  }

  listChanges(pageToken: string): Promise<[DriveChange[], string]> {
    return drive.listChanges(this.tokenManager, pageToken)
  }

  async captureFileMetadata(fileId: string): Promise<[string | null, string | null]> {
    const item = await drive.getFile(this.tokenManager, fileId, 'headRevisionId,md5Checksum')
    return [item.md5Checksum ?? null, item.headRevisionId ?? null]
  }

  downloadRevision(fileId: string, revisionId: string, window?: ByteWindow): Promise<Uint8Array> {
    return drive.downloadRevision(this.tokenManager, fileId, revisionId, window)
  }

  downloadRevisionStream(fileId: string, revisionId: string): AsyncGenerator<Uint8Array, void> {
    return drive.downloadRevisionStream(this.tokenManager, fileId, revisionId)
  }
}
