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
import { GDriveAccessor } from '../../../src/accessor/gdrive.ts'
import { installApi } from '../google/_test_util.ts'
import type { DriveApi } from '../../../src/core/gdrive/api.ts'
import { GoogleApiError, type TokenManager } from '../../../src/core/google/client.ts'
import { FOLDER_MIME, MIME_TO_EXT } from '../../../src/core/google/drive.ts'
import type { DriveChange, DriveFile, SharedDrive } from '../../../src/core/google/drive.ts'
import { ByteSpool } from '../../../src/io/spool.ts'
import { md5Hex } from '../../../src/utils/hash.ts'
import type { ByteWindow } from '../../../src/utils/ranges.ts'

const FILE_MIME = 'application/octet-stream'
const STREAM_CHUNK = 4
export const DOC_MIME = 'application/vnd.google-apps.document'

export const TOKEN_MANAGER = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager

interface FakeItem {
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
  content: Uint8Array
  driveId?: string
}

function bytesOf(data: Uint8Array | ByteSpool): Promise<Uint8Array> {
  return data instanceof ByteSpool ? data.read(0, data.size) : Promise.resolve(data)
}

/** The error Drive's client raises for a refused request. */
export function driveError(status: number, message: string): GoogleApiError {
  return new GoogleApiError(message, status)
}

/** The error Drive's client raises for an id it holds no file for. */
export function notFound(fileId: string): GoogleApiError {
  return driveError(404, `File not found: ${fileId}.`)
}

/** `call()` as a promise, rejected with whatever it throws. */
function answer<T>(call: () => T): Promise<T> {
  try {
    return Promise.resolve(call())
  } catch (err) {
    return Promise.reject(err as Error)
  }
}

function unserved(call: string): Error {
  return new Error(`the fake Drive does not serve ${call}`)
}

/**
 * In-memory Drive: id-addressed items with parent links. It implements the
 * one seam every gdrive core op reaches Drive through, so a test hands it to
 * an accessor (`makeGDriveAccessor`) or installs it behind every accessor
 * (`installDrive`). It keeps one version of each item, so a revision read
 * answers the current content.
 */
export class FakeDrive implements DriveApi {
  items = new Map<string, FakeItem>()
  // Every `limit` a caller asked for, so a test can pin that an emptiness
  // probe is bounded. `pageSize` cannot express that: it caps the page, not
  // the walk, so a small page turns a listing of a large folder into more
  // requests rather than fewer.
  listLimits: (number | undefined)[] = []
  // The parent ids of every full-text search, and whether Drive gave up on
  // a corpus.
  searches: string[][] = []
  incomplete = false
  // The folder ids and shared drive of every listing of several folders at
  // once, and the limit each was handed.
  childQueries: [string[], string | null][] = []
  childLimits: (number | undefined)[] = []
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

  /**
   * The item `id` names, as Drive answers a request for it: a 404 once it is
   * deleted or was never there.
   */
  private item(id: string): FakeItem {
    const item = this.items.get(id)
    if (item === undefined) throw notFound(id)
    return item
  }

  public(id: string): DriveFile {
    const item = this.item(id)
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      modifiedTime: item.modifiedTime,
      parents: [...item.parents],
      size: String(item.content.length),
      ...(item.driveId === undefined ? {} : { driveId: item.driveId }),
      // As Drive does: a folder and a Doc, Sheet or Slides file have neither.
      ...(item.mimeType === FOLDER_MIME || item.mimeType in MIME_TO_EXT
        ? {}
        : { md5Checksum: md5Hex(item.content), headRevisionId: `${item.id}-r1` }),
    }
  }

  listFiles(opts: { folderId: string; limit?: number }): Promise<DriveFile[]> {
    this.listLimits.push(opts.limit)
    const out: DriveFile[] = []
    for (const item of this.items.values()) {
      if (!item.parents.includes(opts.folderId)) continue
      out.push(this.public(item.id))
      if (opts.limit !== undefined && out.length >= opts.limit) break
    }
    return Promise.resolve(out)
  }

  listChildren(
    folderIds: readonly string[],
    driveId: string | null,
    limit?: number,
  ): Promise<DriveFile[]> {
    this.childQueries.push([[...folderIds], driveId])
    this.childLimits.push(limit)
    const out: DriveFile[] = []
    for (const item of this.items.values()) {
      if (item.parents.some((p) => folderIds.includes(p))) out.push(this.public(item.id))
    }
    return Promise.resolve(limit === undefined ? out : out.slice(0, limit))
  }

  listAllFiles(
    opts: {
      mimeType?: string | null
      modifiedAfter?: string | null
      modifiedBefore?: string | null
    } = {},
  ): Promise<{ files: DriveFile[]; complete: boolean }> {
    const files: DriveFile[] = []
    for (const item of this.items.values()) {
      if (opts.mimeType != null && item.mimeType !== opts.mimeType) continue
      if (opts.modifiedAfter != null && item.modifiedTime < opts.modifiedAfter) continue
      if (opts.modifiedBefore != null && item.modifiedTime >= opts.modifiedBefore) continue
      files.push(this.public(item.id))
    }
    return Promise.resolve({ files, complete: !this.incomplete })
  }

  searchFiles(
    text: string,
    parentIds: readonly string[],
    mimeType: string | null = null,
  ): Promise<{ ids: string[]; complete: boolean }> {
    this.searches.push([...parentIds])
    const needle = text.toLowerCase()
    const ids: string[] = []
    for (const item of this.items.values()) {
      if (parentIds.length > 0 && !item.parents.some((p) => parentIds.includes(p))) continue
      if (mimeType !== null && item.mimeType !== mimeType) continue
      if (new TextDecoder().decode(item.content).toLowerCase().includes(needle)) ids.push(item.id)
    }
    return Promise.resolve({ ids, complete: !this.incomplete })
  }

  listSharedDrives(): Promise<SharedDrive[]> {
    return Promise.resolve([])
  }

  getFile(fileId: string): Promise<DriveFile> {
    return answer(() => this.public(fileId))
  }

  storageQuota(): Promise<{ limit?: string; usage?: string }> {
    return Promise.reject(unserved('storageQuota'))
  }

  createFolder(name: string, parentId: string): Promise<DriveFile> {
    return Promise.resolve(this.public(this.folder(name, parentId)))
  }

  async uploadFile(
    name: string,
    parentId: string,
    data: Uint8Array | ByteSpool,
  ): Promise<DriveFile> {
    return this.public(this.add(name, parentId, FILE_MIME, await bytesOf(data)))
  }

  async updateFileContent(fileId: string, data: Uint8Array | ByteSpool): Promise<DriveFile> {
    this.item(fileId).content = await bytesOf(data)
    return this.public(fileId)
  }

  deleteFile(fileId: string): Promise<void> {
    return answer(() => {
      this.item(fileId)
      const stack = [fileId]
      for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
        for (const item of this.items.values()) {
          if (item.parents.includes(current)) stack.push(item.id)
        }
        this.items.delete(current)
      }
    })
  }

  patchFile(
    fileId: string,
    opts: { body: Record<string, unknown>; addParents?: string; removeParents?: string },
  ): Promise<DriveFile> {
    return answer(() => {
      const item = this.item(fileId)
      if (opts.body.name !== undefined) item.name = opts.body.name as string
      item.modifiedTime = (opts.body.modifiedTime as string | undefined) ?? '2026-10-01T00:00:00Z'
      if (opts.addParents !== undefined) item.parents.push(opts.addParents)
      if (opts.removeParents !== undefined) {
        item.parents = item.parents.filter((p) => p !== opts.removeParents)
      }
      return this.public(fileId)
    })
  }

  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile> {
    return answer(() => {
      const src = this.item(fileId)
      return this.public(this.add(name, parentId, src.mimeType, src.content))
    })
  }

  downloadFile(fileId: string, window?: ByteWindow): Promise<Uint8Array> {
    return answer(() => {
      const content = this.item(fileId).content
      if (window === undefined) return content
      const end = window.size === null ? undefined : window.offset + window.size
      return content.slice(window.offset, end)
    })
  }

  async *downloadFileStream(fileId: string): AsyncGenerator<Uint8Array, void> {
    const content = await this.downloadFile(fileId)
    for (let at = 0; at < content.length; at += STREAM_CHUNK) {
      yield content.subarray(at, at + STREAM_CHUNK)
    }
  }

  startPageToken(): Promise<string> {
    return Promise.reject(unserved('startPageToken'))
  }

  listChanges(): Promise<[DriveChange[], string]> {
    return Promise.reject(unserved('listChanges'))
  }

  captureFileMetadata(fileId: string): Promise<[string | null, string | null]> {
    const file = this.public(fileId)
    return Promise.resolve([file.md5Checksum ?? null, file.headRevisionId ?? null])
  }

  downloadRevision(fileId: string, _revisionId: string, window?: ByteWindow): Promise<Uint8Array> {
    return this.downloadFile(fileId, window)
  }

  downloadRevisionStream(fileId: string): AsyncGenerator<Uint8Array, void> {
    return this.downloadFileStream(fileId)
  }
}

/** A `DriveApi` whose every call is a spy. */
export type StubDrive = { [K in keyof DriveApi]: Mock<DriveApi[K]> }

function unarmed<K extends keyof DriveApi>(name: K): Mock<DriveApi[K]> {
  return vi.fn((() => {
    throw new Error(`the test reached Drive.${name} without arming it`)
  }) as DriveApi[K])
}

/**
 * A `DriveApi` that answers only the calls a test arms; an unarmed call
 * throws. Mirrors Python's `StubDrive`.
 */
export function stubDrive(): StubDrive {
  return {
    listFiles: unarmed('listFiles'),
    listChildren: unarmed('listChildren'),
    listSharedDrives: unarmed('listSharedDrives'),
    listAllFiles: unarmed('listAllFiles'),
    searchFiles: unarmed('searchFiles'),
    getFile: unarmed('getFile'),
    storageQuota: unarmed('storageQuota'),
    deleteFile: unarmed('deleteFile'),
    downloadFile: unarmed('downloadFile'),
    downloadFileStream: unarmed('downloadFileStream'),
    createFolder: unarmed('createFolder'),
    uploadFile: unarmed('uploadFile'),
    updateFileContent: unarmed('updateFileContent'),
    patchFile: unarmed('patchFile'),
    copyFile: unarmed('copyFile'),
    startPageToken: unarmed('startPageToken'),
    listChanges: unarmed('listChanges'),
    captureFileMetadata: unarmed('captureFileMetadata'),
    downloadRevision: unarmed('downloadRevision'),
    downloadRevisionStream: unarmed('downloadRevisionStream'),
  }
}

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

/** A GDriveAccessor for My Drive whose seam is `drive`. */
export function makeGDriveAccessor(drive: DriveApi): GDriveAccessor {
  return new FakeDriveAccessor(TOKEN_MANAGER, drive)
}

/** A GDriveAccessor scoped to the folder `folderId`, whose seam is `drive`. */
export function makeScopedGDriveAccessor(folderId: string, drive: DriveApi): GDriveAccessor {
  return new FakeDriveAccessor(
    { config: { clientId: 'cid', refreshToken: 'rt', folderId } } as TokenManager,
    drive,
  )
}

/**
 * Serve `drive` behind every Google accessor, for a test whose VFS builds its
 * own accessor. Undone by `vi.restoreAllMocks()`. Mirrors Python's
 * `install_drive`.
 */
export function installDrive(drive: DriveApi): void {
  installApi({ drive })
}
