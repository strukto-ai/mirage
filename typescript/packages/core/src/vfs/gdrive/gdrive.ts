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
import { GDriveAccessor } from '../../accessor/gdrive.ts'

import { TokenManager } from '../../core/google/client.ts'

import { PROMPT } from './prompt.ts'
import { VFSName } from '../../types.ts'

import { redactGDriveConfig, type GDriveConfig, type GDriveConfigRedacted } from './config.ts'
import { buildDeltaHook } from '../../core/gdrive/watch.ts'
import { type DeltaHook } from '../../watch/index.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../types.ts'
import type { DuEntries } from '../types.ts'
import { readdir as gdriveReaddir } from '../../core/gdrive/readdir.ts'
import { read as gdriveRead } from '../../core/gdrive/read.ts'
import { stat as gdriveStat } from '../../core/gdrive/stat.ts'
import { exists as gdriveExists } from '../../core/gdrive/exists.ts'
import { find as gdriveFind } from '../../core/gdrive/find.ts'
import { size as gdriveDu, entries as gdriveDuAll } from '../../core/gdrive/du/index.ts'
import { write as gdriveWrite } from '../../core/gdrive/write.ts'
import { create as gdriveCreate } from '../../core/gdrive/create.ts'
import { mkdir as gdriveMkdir } from '../../core/gdrive/mkdir.ts'
import { unlink as gdriveUnlink } from '../../core/gdrive/unlink.ts'
import { rmdir as gdriveRmdir } from '../../core/gdrive/rmdir.ts'
import { rmR as gdriveRmR } from '../../core/gdrive/rm.ts'
import { rename as gdriveRename } from '../../core/gdrive/rename.ts'
import { copy as gdriveCopy } from '../../core/gdrive/copy.ts'
import { truncate as gdriveTruncate } from '../../core/gdrive/truncate.ts'

export interface GDriveVFSState {
  type: string
  config: GDriveConfigRedacted
}

export class GDriveVFS extends BaseVFS {
  override readonly name: string = VFSName.GDRIVE
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = PROMPT
  readonly config: GDriveConfig
  override readonly accessor: GDriveAccessor

  constructor(config: GDriveConfig) {
    super()
    this.config = config
    const tm = new TokenManager(config)
    this.accessor = new GDriveAccessor({ tokenManager: tm })
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return gdriveReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return gdriveRead(this.accessor, path, index)
    return gdriveRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return gdriveStat(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return gdriveExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return gdriveFind(this.accessor, path, options)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return gdriveDu(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return gdriveDuAll(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return gdriveWrite(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
    return gdriveCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return gdriveMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return gdriveUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return gdriveRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return gdriveRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return gdriveRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return gdriveCopy(this.accessor, src, dst)
  }

  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    return gdriveCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return gdriveTruncate(this.accessor, path, length, noCreate)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<GDriveVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactGDriveConfig(this.config),
    })
  }
}
