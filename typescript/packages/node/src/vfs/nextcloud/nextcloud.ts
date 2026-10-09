import { BaseVFS } from '@struktoai/mirage-core/vfs/base'

import { VFSName } from '@struktoai/mirage-core/types'

import type { DeltaHook } from '@struktoai/mirage-core/watch/index'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'

import { buildDeltaHook } from '../../core/nextcloud/watch.ts'
import {
  redactNextcloudConfig,
  type NextcloudConfig,
  type NextcloudConfigRedacted,
} from './config.ts'
import { PROMPT } from './prompt.ts'
import type { PathSpec, FileStat } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { FindOptions } from '@struktoai/mirage-core/vfs/types'
import type { DuEntries } from '@struktoai/mirage-core/vfs/types'
import { appendByRewrite } from '@struktoai/mirage-core/core/generic/rewrite'
import { readdir } from '../../core/nextcloud/readdir.ts'
import { read } from '../../core/nextcloud/read.ts'
import { stat } from '../../core/nextcloud/stat.ts'
import { readStream } from '../../core/nextcloud/stream.ts'
import { exists } from '../../core/nextcloud/exists.ts'
import { find } from '../../core/nextcloud/find.ts'
import {
  size as nextcloudDuSize,
  entries as nextcloudDuEntries,
} from '../../core/nextcloud/du/index.ts'
import { write } from '../../core/nextcloud/write.ts'
import { create } from '../../core/nextcloud/create.ts'
import { mkdir } from '../../core/nextcloud/mkdir.ts'
import { unlink } from '../../core/nextcloud/unlink.ts'
import { rmdir } from '../../core/nextcloud/rmdir.ts'
import { rmR } from '../../core/nextcloud/rm.ts'
import { rename } from '../../core/nextcloud/rename.ts'
import { copy } from '../../core/nextcloud/copy.ts'
import { truncate } from '../../core/nextcloud/truncate.ts'
import { SCOPE_ERROR } from '../../core/nextcloud/constants.ts'

export interface NextcloudVFSState {
  type: string
  config: NextcloudConfigRedacted
}

export class NextcloudVFS extends BaseVFS {
  override readonly name = VFSName.NEXTCLOUD
  override readonly cachesReads = true
  // WebDAV PROPFIND carries getcontentlength for every file; readdir
  // backfills any lister-omitted size with one stat per affected file.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot = true
  override readonly prompt = PROMPT
  override readonly accessor: NextcloudAccessor

  constructor(readonly config: NextcloudConfig) {
    super()
    this.accessor = new NextcloudAccessor(config)
  }

  override readonly readsRanges: boolean = true

  override readonly maxGlobMatches: number = SCOPE_ERROR

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

  override duSize(path: PathSpec, _index?: IndexCacheStore): Promise<number> {
    return nextcloudDuSize(this.accessor, path)
  }

  override duEntries(path: PathSpec, _index?: IndexCacheStore): Promise<DuEntries> {
    return nextcloudDuEntries(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return write(this.accessor, path, data)
  }

  override append(path: PathSpec, data: Uint8Array, index?: IndexCacheStore): Promise<void> {
    return appendByRewrite(
      (p) => this.read(p, index),
      (p, d) => this.write(p, d),
      (p) => this.stat(p, index),
      path,
      data,
    )
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

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return truncate(this.accessor, path, length, noCreate)
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<NextcloudVFSState> {
    return Promise.resolve({ type: this.name, config: redactNextcloudConfig(this.config) })
  }
}
