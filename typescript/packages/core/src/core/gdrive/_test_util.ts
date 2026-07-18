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

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { TokenManager } from '../google/_client.ts'
import type { DriveFile } from '../google/drive.ts'

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

// In-memory Drive: id-addressed items with parent links. Test files mock
// ../google/drive.ts and delegate its functions to the current instance.
export class FakeDrive {
  items = new Map<string, FakeItem>()
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

  listFiles(
    _tm: TokenManager,
    opts: { folderId?: string; mimeType?: string | null; name?: string | null } = {},
  ): Promise<DriveFile[]> {
    const folderId = opts.folderId ?? 'root'
    const out: DriveFile[] = []
    for (const item of this.items.values()) {
      if (!item.parents.includes(folderId)) continue
      if (opts.name != null && item.name !== opts.name) continue
      if (opts.mimeType != null && item.mimeType !== opts.mimeType) continue
      out.push(this.public(item.id))
    }
    return Promise.resolve(out)
  }

  listSharedDrives(): Promise<never[]> {
    return Promise.resolve([])
  }

  createFolder(_tm: TokenManager, name: string, parentId: string): Promise<DriveFile> {
    return Promise.resolve(this.public(this.folder(name, parentId)))
  }

  uploadFile(
    _tm: TokenManager,
    name: string,
    parentId: string,
    data: Uint8Array,
    mimeType: string = FILE_MIME,
  ): Promise<DriveFile> {
    return Promise.resolve(this.public(this.add(name, parentId, mimeType, data)))
  }

  updateFileContent(_tm: TokenManager, fileId: string, data: Uint8Array): Promise<DriveFile> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    item.content = data
    return Promise.resolve(this.public(fileId))
  }

  deleteFile(_tm: TokenManager, fileId: string): Promise<void> {
    const stack = [fileId]
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const item of this.items.values()) {
        if (item.parents.includes(current)) stack.push(item.id)
      }
      this.items.delete(current)
    }
    return Promise.resolve()
  }

  patchFile(
    _tm: TokenManager,
    fileId: string,
    opts: { body?: Record<string, unknown>; addParents?: string; removeParents?: string } = {},
  ): Promise<DriveFile> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    if (opts.body?.name !== undefined) item.name = opts.body.name as string
    if (opts.addParents !== undefined) item.parents.push(opts.addParents)
    if (opts.removeParents !== undefined) {
      item.parents = item.parents.filter((p) => p !== opts.removeParents)
    }
    return Promise.resolve(this.public(fileId))
  }

  copyFile(_tm: TokenManager, fileId: string, name: string, parentId: string): Promise<DriveFile> {
    const src = this.items.get(fileId)
    if (src === undefined) throw new Error(`no item ${fileId}`)
    return Promise.resolve(this.public(this.add(name, parentId, src.mimeType, src.content)))
  }

  downloadFile(_tm: TokenManager, fileId: string): Promise<Uint8Array> {
    const item = this.items.get(fileId)
    if (item === undefined) throw new Error(`no item ${fileId}`)
    return Promise.resolve(item.content)
  }

  getFile(_tm: TokenManager, fileId: string): Promise<DriveFile> {
    if (!this.items.has(fileId)) throw new Error(`no item ${fileId}`)
    return Promise.resolve(this.public(fileId))
  }
}

// Mutable singleton the module mock delegates to; reset per test.
let currentFakeDrive = new FakeDrive()

export function resetFakeDrive(): FakeDrive {
  currentFakeDrive = new FakeDrive()
  return currentFakeDrive
}

// vi.mock factory body for ../google/drive.ts: keeps real constants and
// pure helpers, routes API calls to the current FakeDrive.
export function driveModuleMock(actual: object): object {
  return {
    ...actual,
    listFiles: (...args: unknown[]) =>
      currentFakeDrive.listFiles(args[0] as TokenManager, args[1] as never),
    listSharedDrives: () => currentFakeDrive.listSharedDrives(),
    createFolder: (...args: unknown[]) =>
      currentFakeDrive.createFolder(args[0] as TokenManager, args[1] as string, args[2] as string),
    uploadFile: (...args: unknown[]) =>
      currentFakeDrive.uploadFile(
        args[0] as TokenManager,
        args[1] as string,
        args[2] as string,
        args[3] as Uint8Array,
        args[4] as string | undefined,
      ),
    updateFileContent: (...args: unknown[]) =>
      currentFakeDrive.updateFileContent(
        args[0] as TokenManager,
        args[1] as string,
        args[2] as Uint8Array,
      ),
    deleteFile: (...args: unknown[]) =>
      currentFakeDrive.deleteFile(args[0] as TokenManager, args[1] as string),
    patchFile: (...args: unknown[]) =>
      currentFakeDrive.patchFile(args[0] as TokenManager, args[1] as string, args[2] as never),
    copyFile: (...args: unknown[]) =>
      currentFakeDrive.copyFile(
        args[0] as TokenManager,
        args[1] as string,
        args[2] as string,
        args[3] as string,
      ),
    downloadFile: (...args: unknown[]) =>
      currentFakeDrive.downloadFile(args[0] as TokenManager, args[1] as string),
    getFile: (...args: unknown[]) =>
      currentFakeDrive.getFile(args[0] as TokenManager, args[1] as string),
  }
}

export function makeGDriveAccessor(): GDriveAccessor {
  return new GDriveAccessor({
    tokenManager: { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager,
  })
}

export function makeScopedGDriveAccessor(folderId: string): GDriveAccessor {
  return new GDriveAccessor({
    tokenManager: { config: { clientId: 'cid', refreshToken: 'rt', folderId } } as TokenManager,
  })
}
