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

import { PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactDropboxConfig, type DropboxConfig, type DropboxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/dropbox/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { DuEntries, MkdirOp } from '../types.ts'
import { readdir as dropboxReaddir } from '../../core/dropbox/readdir.ts'
import { read as dropboxRead, readStream as dropboxStream } from '../../core/dropbox/read.ts'
import { stat as dropboxStat } from '../../core/dropbox/stat.ts'
import { exists as dropboxExists } from '../../core/dropbox/exists.ts'
import { makeWalkedDu } from '../../core/generic/du.ts'
import { truncateByRewrite } from '../../core/generic/rewrite.ts'
import { write as dropboxWrite } from '../../core/dropbox/write.ts'
import { create as dropboxCreate } from '../../core/dropbox/create.ts'
import { mkdir as dropboxMkdir } from '../../core/dropbox/mkdir.ts'
import { unlink as dropboxUnlink } from '../../core/dropbox/unlink.ts'
import { rmdir as dropboxRmdir } from '../../core/dropbox/rmdir.ts'
import { rmR as dropboxRmR } from '../../core/dropbox/rm.ts'
import { rename as dropboxRename } from '../../core/dropbox/rename.ts'
import { copy as dropboxCopy } from '../../core/dropbox/copy.ts'
import { filesContaining as dropboxFilesContaining } from '../../core/dropbox/search.ts'

const du = makeWalkedDu(dropboxStat, dropboxReaddir)

const mkdirOp: MkdirOp<DropboxAccessor> = (accessor, path, parents) =>
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
  override readonly prompt: string = PROMPT
  readonly config: DropboxConfig
  override readonly accessor: DropboxAccessor

  constructor(config: DropboxConfig) {
    super()
    this.config = config
    const tm = new DropboxTokenManager(config)
    this.accessor = new DropboxAccessor({
      tokenManager: tm,
      ...(config.rootPath !== undefined ? { rootPath: config.rootPath } : {}),
      ...(config.contentSearch !== undefined ? { contentSearch: config.contentSearch } : {}),
    })
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return dropboxReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return dropboxRead(this.accessor, path, index)
    return dropboxRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return dropboxStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return dropboxStream(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return dropboxExists(this.accessor, path)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return du.size(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return du.entries(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return dropboxWrite(this.accessor, path, data)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return truncateByRewrite(
      (p) => this.read(p),
      (p, d) => this.write(p, d),
      path,
      length,
      noCreate,
    )
  }

  override create(path: PathSpec): Promise<void> {
    return dropboxCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return mkdirOp(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return dropboxUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
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

  override filesContaining(
    text: string,
    under: PathSpec[],
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<Set<string> | null> {
    if (!opts.wholeWord || !this.accessor.contentSearch) return Promise.resolve(null)
    return dropboxFilesContaining(this.accessor, text, under)
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
