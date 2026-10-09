import { BaseVFS } from '../base.ts'
import {
  OneDriveAccessor,
  redactOneDriveConfig,
  type OneDriveConfig,
  type OneDriveConfigRedacted,
} from '../../accessor/onedrive.ts'

import { VFSName } from '../../types.ts'
import { PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/onedrive/watch.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../types.ts'
import type { DuEntries } from '../types.ts'
import { readdir } from '../../core/onedrive/readdir.ts'
import { read } from '../../core/onedrive/read.ts'
import { stat } from '../../core/onedrive/stat.ts'
import { readStream } from '../../core/onedrive/stream.ts'
import { exists } from '../../core/onedrive/exists.ts'
import { find } from '../../core/onedrive/find.ts'
import { makeWalkedDu } from '../../core/generic/du.ts'
import { write } from '../../core/onedrive/write.ts'
import { create } from '../../core/onedrive/create.ts'
import { mkdir } from '../../core/onedrive/mkdir.ts'
import { unlink } from '../../core/onedrive/unlink.ts'
import { rmdir } from '../../core/onedrive/rmdir.ts'
import { rmR } from '../../core/onedrive/rm.ts'
import { rename } from '../../core/onedrive/rename.ts'
import { copy } from '../../core/onedrive/copy.ts'
import { truncate } from '../../core/onedrive/truncate.ts'

const du = makeWalkedDu(stat, readdir)

export interface OneDriveVFSState {
  type: string
  config: OneDriveConfigRedacted
}

export class OneDriveVFS extends BaseVFS {
  override readonly name: string = VFSName.ONEDRIVE
  override readonly cachesReads: boolean = true
  // Graph driveItems carry an exact byte `size` for every file in both
  // listings and item gets; folders (including the root) report null with
  // the aggregate storage number in extra.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  // stat and every read that can fill the cache stamp the item's cTag, the
  // read taking it before the bytes, so the gate compares like with like.
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = PROMPT
  override readonly accessor: OneDriveAccessor
  private readonly config: OneDriveConfig

  constructor(config: OneDriveConfig) {
    super()
    this.config = config
    this.accessor = new OneDriveAccessor(config)
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return readdir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return read(this.accessor, path, index)
    return read(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return stat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return readStream(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return exists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return find(this.accessor, path, options)
  }

  override duSize(path: PathSpec, index?: IndexCacheStore): Promise<number> {
    return du.size(this.accessor, path, index)
  }

  override duEntries(path: PathSpec, index?: IndexCacheStore): Promise<DuEntries> {
    return du.entries(this.accessor, path, index)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return write(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
    return create(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return mkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return unlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return rmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return rmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return rename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copy(this.accessor, src, dst)
  }

  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return truncate(this.accessor, path, length, noCreate)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): OneDriveVFSState {
    const config: OneDriveConfigRedacted = redactOneDriveConfig(this.config)
    return { type: this.name, config }
  }
}
