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
import type { CapacityResult, DirListing, FileStat, PathSpec, SetAttrFields } from '../../types.ts'
import type { Handed } from '../types.ts'
import { readdir as gdriveReaddir } from '../../core/gdrive/readdir.ts'
import { read as gdriveRead, readStream as gdriveStream } from '../../core/gdrive/read.ts'
import { capacity as gdriveCapacity } from '../../core/gdrive/capacity.ts'
import { checksum as gdriveChecksum } from '../../core/gdrive/checksum.ts'
import { setAttrs as gdriveSetAttrs } from '../../core/gdrive/set_attrs.ts'
import { stat as gdriveStat } from '../../core/gdrive/stat.ts'
import { exists as gdriveExists } from '../../core/gdrive/exists.ts'
import { write as gdriveWrite } from '../../core/gdrive/write.ts'
import { create as gdriveCreate } from '../../core/gdrive/create.ts'
import { mkdir as gdriveMkdir } from '../../core/gdrive/mkdir.ts'
import { unlink as gdriveUnlink } from '../../core/gdrive/unlink.ts'
import { rmdir as gdriveRmdir } from '../../core/gdrive/rmdir.ts'
import { rmR as gdriveRmR } from '../../core/gdrive/rm.ts'
import { rename as gdriveRename } from '../../core/gdrive/rename.ts'
import { copy as gdriveCopy } from '../../core/gdrive/copy.ts'
import { truncate as gdriveTruncate } from '../../core/gdrive/truncate.ts'
import { filesContaining as gdriveFilesContaining } from '../../core/gdrive/search.ts'

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
  override readonly handed = {
    readdir: ['entry'],
    read: ['entry'],
    stat: ['entry'],
    checksum: ['entry'],
    readStream: ['entry'],
    exists: ['entry'],
    write: ['entry', 'parent'],
    create: ['entry', 'parent'],
    mkdir: ['parent'],
    unlink: ['entry'],
    rmdir: ['entry'],
    rmR: ['entry'],
    rename: ['entry', 'parent', 'dstParent', 'dstEntry'],
    copy: ['entry', 'dstParent', 'dstEntry'],
    dirCopy: ['entry', 'dstParent', 'dstEntry'],
    truncate: ['entry', 'parent'],
    setattr: ['entry'],
    filesContaining: ['entry'],
  } as const
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

  override readdir(path: PathSpec, handed?: Handed): Promise<FileStat[] | DirListing> {
    return gdriveReaddir(this.accessor, path, handed?.entry)
  }

  override read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) {
      return gdriveRead(this.accessor, path, undefined, handed?.entry)
    }
    return gdriveRead(
      this.accessor,
      path,
      size === null ? { offset } : { offset, size },
      handed?.entry,
    )
  }

  override stat(path: PathSpec, handed?: Handed): Promise<FileStat> {
    return gdriveStat(this.accessor, path, handed?.entry)
  }

  override checksum(path: PathSpec, algorithm: string, handed?: Handed): Promise<string | null> {
    return gdriveChecksum(this.accessor, path, algorithm, handed?.entry)
  }

  override readStream(path: PathSpec, handed?: Handed): AsyncIterable<Uint8Array> {
    return gdriveStream(this.accessor, path, handed?.entry)
  }

  override exists(path: PathSpec, handed?: Handed): Promise<boolean> {
    return gdriveExists(this.accessor, path, handed?.entry)
  }

  override write(
    path: PathSpec,
    data: Uint8Array,
    _signal?: AbortSignal,
    handed: Handed = {},
  ): Promise<FileStat | null> {
    return gdriveWrite(this.accessor, path, data, handed)
  }

  override create(path: PathSpec, handed: Handed = {}): Promise<FileStat | null> {
    return gdriveCreate(this.accessor, path, handed)
  }

  override mkdir(path: PathSpec, parents = false, handed: Handed = {}): Promise<FileStat | null> {
    return gdriveMkdir(this.accessor, path, parents, handed)
  }

  override unlink(path: PathSpec, handed?: Handed): Promise<void> {
    return gdriveUnlink(this.accessor, path, handed)
  }

  override rmdir(path: PathSpec, handed?: Handed): Promise<void> {
    return gdriveRmdir(this.accessor, path, handed)
  }

  override rmR(path: PathSpec, handed: Handed = {}): Promise<void> {
    return gdriveRmR(this.accessor, path, handed)
  }

  override rename(src: PathSpec, dst: PathSpec, handed: Handed = {}): Promise<FileStat | null> {
    return gdriveRename(this.accessor, src, dst, handed)
  }

  override copy(
    src: PathSpec,
    dst: PathSpec,
    signal?: AbortSignal,
    handed: Handed = {},
  ): Promise<FileStat | null> {
    return gdriveCopy(this.accessor, src, dst, signal, handed)
  }

  override dirCopy(src: PathSpec, dst: PathSpec, handed: Handed = {}): Promise<FileStat | null> {
    return gdriveCopy(this.accessor, src, dst, undefined, handed)
  }

  override truncate(
    path: PathSpec,
    length: number,
    noCreate = false,
    handed: Handed = {},
  ): Promise<void> {
    return gdriveTruncate(this.accessor, path, length, noCreate, handed)
  }

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
    handed?: Handed,
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.config.contentSearch !== true) return Promise.resolve(null)
    return gdriveFilesContaining(this.accessor, text, path, handed?.entry)
  }

  override setattr(
    path: PathSpec,
    fields: SetAttrFields,
    handed?: Handed,
  ): Promise<Record<string, number | string>> {
    return gdriveSetAttrs(this.accessor, path, fields, handed?.entry ?? null)
  }

  override capacity(): Promise<CapacityResult> {
    return gdriveCapacity(this.accessor)
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
