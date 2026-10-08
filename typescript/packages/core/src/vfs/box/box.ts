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
import { BoxAccessor } from '../../accessor/box.ts'

import { BoxTokenManager } from '../../core/box/client.ts'

import { PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactBoxConfig, type BoxConfig, type BoxConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/box/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { DuEntries } from '../types.ts'
import { readdir as boxReaddir } from '../../core/box/readdir.ts'
import { read as boxRead, readStream as boxStream } from '../../core/box/read.ts'
import { stat as boxStat } from '../../core/box/stat.ts'
import { exists as boxExists } from '../../core/box/exists.ts'
import { makeWalkedDu } from '../../core/generic/du.ts'
import { write as boxWrite } from '../../core/box/write.ts'
import { create as boxCreate } from '../../core/box/create.ts'
import { mkdir as boxMkdir } from '../../core/box/mkdir.ts'
import { unlink as boxUnlink } from '../../core/box/unlink.ts'
import { rmdir as boxRmdir, rmR as boxRmR } from '../../core/box/rmdir.ts'
import { rename as boxRename } from '../../core/box/rename.ts'
import { copy as boxCopy } from '../../core/box/copy.ts'
import { truncate as boxTruncate } from '../../core/box/truncate.ts'
import { narrowPaths as boxNarrowPaths } from '../../core/box/search.ts'

const du = makeWalkedDu(boxStat, boxReaddir)

const enabledOp = (accessor: BoxAccessor) => accessor.contentSearch

export interface BoxVFSState {
  type: string
  config: BoxConfigRedacted
}

export class BoxVFS extends BaseVFS {
  override readonly name: string = VFSName.BOX
  override readonly cachesReads: boolean = true
  // Box item listings carry an exact byte `size` for every file (0
  // included); sizeless weblinks are filtered out of listings.
  override readonly sizesAlwaysKnown: boolean = true
  // stat and every whole read stamp the file's sha1, which a listing row
  // and GET /files/{id} carry. A download names no version, so a read
  // checks its bytes against the row it resolved through.
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = PROMPT
  readonly config: BoxConfig
  override readonly accessor: BoxAccessor

  constructor(config: BoxConfig) {
    super()
    this.config = config
    // The whole config goes to the token manager, never a hand-picked
    // subset: a field added to BoxConfig would silently stop reaching it
    // (that is how gdrive lost apiBase and kept refreshing at the real
    // Google endpoint against a fake server).
    const tm = new BoxTokenManager(config)
    this.accessor = new BoxAccessor({
      tokenManager: tm,
      ...(config.rootFolderId !== undefined ? { rootFolderId: config.rootFolderId } : {}),
      ...(config.contentSearch !== undefined ? { contentSearch: config.contentSearch } : {}),
    })
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return boxReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return boxRead(this.accessor, path, index)
    return boxRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return boxStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return boxStream(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return boxExists(this.accessor, path)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return du.size(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return du.entries(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return boxWrite(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
    return boxCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return boxMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return boxUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return boxRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return boxRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return boxRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return boxCopy(this.accessor, src, dst)
  }

  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    return boxCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return boxTruncate(this.accessor, path, length, noCreate)
  }

  override narrowPaths(query: string, paths: PathSpec[]): Promise<PathSpec[] | null> {
    return boxNarrowPaths(this.accessor, query, paths)
  }

  override contentSearchEnabled(): boolean {
    return enabledOp(this.accessor)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<BoxVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactBoxConfig(this.config),
    })
  }
}
