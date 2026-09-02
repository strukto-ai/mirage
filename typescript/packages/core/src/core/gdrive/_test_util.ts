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

import type { Mock } from 'vitest'
import { vi } from 'vitest'
import { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { TokenManager } from '../google/client.ts'
import type { DriveFile } from '../google/drive.ts'
import type { DriveApi, ListFilesOptions, PatchFileOptions } from './api.ts'
import type { DriveRevision } from './versions.ts'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_MIME = 'application/octet-stream'
export const DOC_MIME = 'application/vnd.google-apps.document'

export interface FakeItem {
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
  content: Uint8Array
  driveId?: string
}

// In-memory Drive: id-addressed items with parent links. It implements the
// one seam every gdrive module reaches the API through, so a test installs
// it by handing it to the accessor rather than by mocking modules.
export class FakeDrive implements DriveApi {
  items = new Map<string, FakeItem>()
  // Every `limit` a caller asked for, so a test can pin that an emptiness
  // probe is bounded. `pageSize` cannot express that: it caps the page, not
  // the walk, so a small page turns a listing of a large folder into more
  // requests rather than fewer.
  listLimits: (number | null | undefined)[] = []
  private counter = 0

  add(
    name: string,
    parent = 'root',
    mime = FILE_MIME,
    content: Uint8Array = new Uint8Array(0),
    driveId?: string,
  ): string {
    this.counter += 1
    const id = `id${String(this.counter)}`
    this.items.set(id, {
      id,
      name,
      mimeType: mime,
      parents: [parent],
      modifiedTime: '2026-01-01T00:00:00Z',
      content,
      ...(driveId === undefined ? {} : { driveId }),
    })
    return id
  }

  folder(name: string, parent = 'root'): string {
    return this.add(name, parent, FOLDER_MIME)
  }

  find(name: string): FakeItem | null {
    for (const item of this.items.values()) if (item.name === name) return item
    return null
  }

  public(id: string): DriveFile {
    const item = this.items.get(id)
    if (item === undefined) throw new Error(`no item ${id}`)
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      modifiedTime: item.modifiedTime,
      parents: [...item.parents],
      size: String(item.content.length),
      ...(item.driveId === undefined ? {} : { driveId: item.driveId }),
    }
  }

  listFiles(opts: ListFilesOptions = {}): Promise<DriveFile[]> {
    this.listLimits.push(opts.limit)
    const folderId = opts.folderId ?? 'root'
    const out: DriveFile[] = []
    for (const item of this.items.values()) {
      if (!item.parents.includes(folderId)) continue
      if (opts.name != null && item.name !== opts.name) continue
      if (opts.mimeType != null && item.mimeType !== opts.mimeType) continue
      out.push(this.public(item.id))
      if (opts.limit != null && out.length >= opts.limit) break
    }
    return Promise.resolve(out)
  }

  listSharedDrives(): Promise<never[]> {
    return Promise.resolve([])
  }

  createFolder(name: string, parentId: string): Promise<DriveFile> {
    return Promise.resolve(this.public(this.folder(name, parentId)))
  }

  uploadFile(
    name: string,
    parentId: string,
    data: Uint8Array,
    mimeType: string = FILE_MIME,
  ): Promise<DriveFile> {
    return Promise.resolve(this.public(this.add(name, parentId, mimeType, data)))
  }

  updateFileContent(fileId: string, data: Uint8Array): Promise<DriveFile> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    item.content = data
    return Promise.resolve(this.public(fileId))
  }

  deleteFile(fileId: string): Promise<void> {
    const stack = [fileId]
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const item of this.items.values()) {
        if (item.parents.includes(current)) stack.push(item.id)
      }
      this.items.delete(current)
    }
    return Promise.resolve()
  }

  patchFile(fileId: string, opts: PatchFileOptions = {}): Promise<DriveFile> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    if (opts.body?.name !== undefined) item.name = opts.body.name as string
    if (opts.addParents !== undefined) item.parents.push(opts.addParents)
    if (opts.removeParents !== undefined) {
      item.parents = item.parents.filter((p) => p !== opts.removeParents)
    }
    return Promise.resolve(this.public(fileId))
  }

  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile> {
    const src = this.items.get(fileId)
    if (src === undefined) throw new Error(`no item ${fileId}`)
    return Promise.resolve(this.public(this.add(name, parentId, src.mimeType, src.content)))
  }

  downloadFile(fileId: string): Promise<Uint8Array> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    return Promise.resolve(item.content)
  }

  getFile(fileId: string): Promise<DriveFile> {
    if (!this.items.has(fileId)) throw new Error(`no item ${fileId}`)
    return Promise.resolve(this.public(fileId))
  }

  // The fake keeps no revision history: an item has only its current
  // content. The three revision calls are here so it satisfies the whole
  // seam, and answer from that one version.
  listRevisions(): Promise<DriveRevision[]> {
    return Promise.resolve([])
  }

  downloadRevision(fileId: string): Promise<Uint8Array> {
    return this.downloadFile(fileId)
  }

  captureFileMetadata(fileId: string): Promise<[string | null, string | null]> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    return Promise.resolve([item.modifiedTime, null])
  }
}

// The seam with every method a spy. A test that wants to assert on the
// requests themselves (or to fail one) uses this instead of FakeDrive, and
// still covers the whole surface, so a call it did not stub answers
// undefined rather than reaching the network.
export type StubDrive = { [K in keyof DriveApi]: Mock<DriveApi[K]> }

export function stubDrive(): StubDrive {
  return {
    listFiles: vi.fn<DriveApi['listFiles']>(),
    listSharedDrives: vi.fn<DriveApi['listSharedDrives']>(),
    getFile: vi.fn<DriveApi['getFile']>(),
    deleteFile: vi.fn<DriveApi['deleteFile']>(),
    downloadFile: vi.fn<DriveApi['downloadFile']>(),
    createFolder: vi.fn<DriveApi['createFolder']>(),
    uploadFile: vi.fn<DriveApi['uploadFile']>(),
    updateFileContent: vi.fn<DriveApi['updateFileContent']>(),
    patchFile: vi.fn<DriveApi['patchFile']>(),
    copyFile: vi.fn<DriveApi['copyFile']>(),
    listRevisions: vi.fn<DriveApi['listRevisions']>(),
    downloadRevision: vi.fn<DriveApi['downloadRevision']>(),
    captureFileMetadata: vi.fn<DriveApi['captureFileMetadata']>(),
  }
}

// A GDriveAccessor whose seam is the given fake. The base builds a live
// client per access, so overriding the getter is what installs the fake for
// every module that reaches the API through it.
class FakeDriveAccessor extends GDriveAccessor {
  private readonly fake: DriveApi

  constructor(tokenManager: TokenManager, fake: DriveApi) {
    super({ tokenManager })
    this.fake = fake
  }

  override get drive(): DriveApi {
    return this.fake
  }
}

export function makeGDriveAccessor(drive: DriveApi): GDriveAccessor {
  return new FakeDriveAccessor(
    { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
    drive,
  )
}

export function makeScopedGDriveAccessor(folderId: string, drive: DriveApi): GDriveAccessor {
  return new FakeDriveAccessor(
    { config: { clientId: 'cid', refreshToken: 'rt', folderId } } as TokenManager,
    drive,
  )
}
