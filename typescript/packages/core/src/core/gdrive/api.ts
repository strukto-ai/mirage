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

import type { TokenManager } from '../google/client.ts'
import type { DriveFile, SharedDrive } from '../google/drive.ts'
import {
  copyFile,
  createFolder,
  deleteFile,
  downloadFile,
  getFile,
  listFiles,
  listSharedDrives,
  patchFile,
  updateFileContent,
  uploadFile,
} from '../google/drive.ts'
import type { DriveRevision } from './versions.ts'
import { captureFileMetadata, downloadRevision, listRevisions } from './versions.ts'
import type { ByteWindow } from '../../utils/ranges.ts'

// The option bags are read off the wire functions rather than restated, so
// a change to one of them is a compile error here instead of a silent
// divergence between the seam and the request it stands for.
export type ListFilesOptions = NonNullable<Parameters<typeof listFiles>[1]>
export type ListSharedDrivesOptions = NonNullable<Parameters<typeof listSharedDrives>[1]>
export type PatchFileOptions = NonNullable<Parameters<typeof patchFile>[2]>

/**
 * Every Drive request the gdrive backend makes, in one place.
 *
 * gdrive is the one backend with no natural client object: its calls are
 * free functions over a `TokenManager`, so each module used to import the
 * ones it needed by value and a fake had to be installed at every one of
 * those module sites. A new call site then escaped the fake silently. This
 * is that seam: core modules take a `DriveApi`, never a wire function.
 */
export interface DriveApi {
  listFiles(opts?: ListFilesOptions): Promise<DriveFile[]>
  listSharedDrives(opts?: ListSharedDrivesOptions): Promise<SharedDrive[]>
  getFile(fileId: string): Promise<DriveFile>
  deleteFile(fileId: string): Promise<void>
  downloadFile(fileId: string, window?: ByteWindow): Promise<Uint8Array>
  createFolder(name: string, parentId: string): Promise<DriveFile>
  uploadFile(
    name: string,
    parentId: string,
    data: Uint8Array,
    mimeType?: string,
  ): Promise<DriveFile>
  updateFileContent(fileId: string, data: Uint8Array, mimeType?: string): Promise<DriveFile>
  patchFile(fileId: string, opts?: PatchFileOptions): Promise<DriveFile>
  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile>
  listRevisions(fileId: string): Promise<DriveRevision[]>
  downloadRevision(fileId: string, revisionId: string, window?: ByteWindow): Promise<Uint8Array>
  captureFileMetadata(fileId: string): Promise<[string | null, string | null]>
}

// The live implementation: one delegating method per call, with the token
// manager prepended. Nothing else belongs here — a method that decided
// anything would be behavior a fake silently drops.
export class DriveClient implements DriveApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  listFiles(opts: ListFilesOptions = {}): Promise<DriveFile[]> {
    return listFiles(this.tokenManager, opts)
  }

  listSharedDrives(opts: ListSharedDrivesOptions = {}): Promise<SharedDrive[]> {
    return listSharedDrives(this.tokenManager, opts)
  }

  getFile(fileId: string): Promise<DriveFile> {
    return getFile(this.tokenManager, fileId)
  }

  deleteFile(fileId: string): Promise<void> {
    return deleteFile(this.tokenManager, fileId)
  }

  downloadFile(fileId: string, window?: ByteWindow): Promise<Uint8Array> {
    return downloadFile(this.tokenManager, fileId, window)
  }

  createFolder(name: string, parentId: string): Promise<DriveFile> {
    return createFolder(this.tokenManager, name, parentId)
  }

  uploadFile(
    name: string,
    parentId: string,
    data: Uint8Array,
    mimeType?: string,
  ): Promise<DriveFile> {
    return uploadFile(this.tokenManager, name, parentId, data, mimeType)
  }

  updateFileContent(fileId: string, data: Uint8Array, mimeType?: string): Promise<DriveFile> {
    return updateFileContent(this.tokenManager, fileId, data, mimeType)
  }

  patchFile(fileId: string, opts: PatchFileOptions = {}): Promise<DriveFile> {
    return patchFile(this.tokenManager, fileId, opts)
  }

  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile> {
    return copyFile(this.tokenManager, fileId, name, parentId)
  }

  listRevisions(fileId: string): Promise<DriveRevision[]> {
    return listRevisions(this.tokenManager, fileId)
  }

  downloadRevision(fileId: string, revisionId: string, window?: ByteWindow): Promise<Uint8Array> {
    return downloadRevision(this.tokenManager, fileId, revisionId, window)
  }

  captureFileMetadata(fileId: string): Promise<[string | null, string | null]> {
    return captureFileMetadata(this.tokenManager, fileId)
  }
}

export function driveApi(tokenManager: TokenManager): DriveApi {
  return new DriveClient(tokenManager)
}
