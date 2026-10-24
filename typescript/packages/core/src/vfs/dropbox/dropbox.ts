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

import { BaseVFS } from '../base.ts'
import { DropboxAccessor } from '../../accessor/dropbox.ts'
import { DropboxTokenManager } from '../../core/dropbox/client.ts'
import { VFSName } from '../../types.ts'
import { redactDropboxConfig, type DropboxConfig, type DropboxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/dropbox/events.ts'
import { type DeltaHook } from '../../events/index.ts'
import type { CapacityResult, DirListing, PathSpec, FileStat } from '../../types.ts'
import { capacity as dropboxCapacity } from '../../core/dropbox/capacity.ts'
import type { Handed } from '../types.ts'
import { readdir as dropboxReaddir } from '../../core/dropbox/readdir.ts'
import {
  read as dropboxRead,
  readByPath as dropboxReadByPath,
  readStream as dropboxStream,
} from '../../core/dropbox/read.ts'
import { stat as dropboxStat, tree as dropboxTree } from '../../core/dropbox/stat.ts'
import { exists as dropboxExists } from '../../core/dropbox/exists.ts'
import { truncateByRewrite } from '../../core/generic/rewrite.ts'
import type { ByteSource } from '../../io/types.ts'
import { write as dropboxWrite } from '../../core/dropbox/write.ts'
import { create as dropboxCreate } from '../../core/dropbox/create.ts'
import { mkdir as dropboxMkdir } from '../../core/dropbox/mkdir.ts'
import { unlink as dropboxUnlink } from '../../core/dropbox/unlink.ts'
import { rmdir as dropboxRmdir } from '../../core/dropbox/rmdir.ts'
import { rmR as dropboxRmR } from '../../core/dropbox/rm.ts'
import { rename as dropboxRename } from '../../core/dropbox/rename.ts'
import { copy as dropboxCopy, dirCopy as dropboxDirCopy } from '../../core/dropbox/copy.ts'
import { filesContaining as dropboxFilesContaining } from '../../core/dropbox/search.ts'
import { WALK_LIMIT } from '../constants.ts'

const mkdirOp = (accessor: DropboxAccessor, path: PathSpec, parents?: boolean): Promise<void> =>
  dropboxMkdir(accessor, path, parents)

export interface DropboxVFSState {
  type: string
  config: DropboxConfigRedacted
}

export class DropboxVFS extends BaseVFS {
  override readonly name: string = VFSName.DROPBOX
  override readonly cachesReads: boolean = true
  // list_folder carries an exact byte `size` for every file (0 included).
  // Paper docs 409 on raw download, a loud error, never a silent empty read.
  override readonly sizesAlwaysKnown: boolean = true
  // stat and every read stamp content_hash: a listing row and get_metadata
  // carry it, and a download, ranged or not, names it in Dropbox-API-Result
  // at no extra request.
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly handed = {
    read: ['entry'],
    truncate: ['entry'],
  } as const
  override readonly wholeWordSearch: boolean = true
  readonly config: DropboxConfig
  override readonly accessor: DropboxAccessor

  override readonly walkLimit: number

  constructor(config: DropboxConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    const tm = new DropboxTokenManager(config)
    this.accessor = new DropboxAccessor({
      tokenManager: tm,
      ...(config.rootPath !== undefined ? { rootPath: config.rootPath } : {}),
    })
  }

  override readonly readsRanges: boolean = true

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return dropboxTree(this.accessor, path)
  }

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return dropboxReaddir(this.accessor, path, handed?.limit)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return dropboxStream(this.accessor, path, handed?.entry)
    return dropboxRead(
      this.accessor,
      path,
      size === null ? { offset } : { offset, size },
      handed?.entry,
    )
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return dropboxStat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return dropboxExists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource, signal?: AbortSignal): Promise<FileStat | null> {
    return dropboxWrite(this.accessor, path, data, signal)
  }

  override truncate(
    path: PathSpec,
    length: number,
    noCreate = false,
    handed: Handed = {},
  ): Promise<void> {
    return truncateByRewrite(
      (p) =>
        handed.entry === undefined || handed.entry === null
          ? dropboxReadByPath(this.accessor, p)
          : dropboxRead(this.accessor, p, undefined, handed.entry),
      async (p, d) => {
        await this.write(p, d)
      },
      path,
      length,
      noCreate,
    )
  }

  override create(path: PathSpec): Promise<FileStat | null> {
    return dropboxCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return mkdirOp(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return dropboxUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec): Promise<void> {
    return dropboxRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return dropboxRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return dropboxRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return dropboxCopy(this.accessor, src, dst)
  }

  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    return dropboxDirCopy(this.accessor, src, dst)
  }

  /**
   * Whether this VFS answers `name`; with no walk limit it reads every
   * file rather than ask the service's search.
   */
  override supports(name: string): boolean {
    if (name === 'files_containing' && this.walkLimit < 0) return false
    return super.supports(name)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.walkLimit < 0) return Promise.resolve(null)
    return dropboxFilesContaining(this.accessor, text, [path])
  }

  override capacity(): Promise<CapacityResult> {
    return dropboxCapacity(this.accessor)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<DropboxVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactDropboxConfig(this.config),
    })
  }
}
