import { BaseVFS } from '../base.ts'
import {
  redactSharePointConfig,
  SharePointAccessor,
  type SharePointConfig,
  type SharePointConfigRedacted,
} from '../../accessor/sharepoint.ts'
import { VFSName } from '../../types.ts'
import { PROMPT } from './prompt.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { buildDeltaHook } from '../../core/sharepoint/watch.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { Handed } from '../types.ts'
import { readdir } from '../../core/sharepoint/readdir.ts'
import { read } from '../../core/sharepoint/read.ts'
import { stat } from '../../core/sharepoint/stat.ts'
import { readStream } from '../../core/sharepoint/stream.ts'
import { exists } from '../../core/sharepoint/exists.ts'
import { write } from '../../core/sharepoint/write.ts'
import { create } from '../../core/sharepoint/create.ts'
import { mkdir } from '../../core/sharepoint/mkdir.ts'
import { unlink } from '../../core/sharepoint/unlink.ts'
import { rmdir } from '../../core/sharepoint/rmdir.ts'
import { rmR } from '../../core/sharepoint/rm.ts'
import { rename } from '../../core/sharepoint/rename.ts'
import { copy } from '../../core/sharepoint/copy.ts'
import { truncate } from '../../core/sharepoint/truncate.ts'
import { filesContaining } from '../../core/sharepoint/search.ts'

export interface SharePointVFSState {
  type: string
  config: SharePointConfigRedacted
}

export class SharePointVFS extends BaseVFS {
  override readonly name: string = VFSName.SHAREPOINT
  override readonly cachesReads: boolean = true
  // Graph drive items carry an exact content-length size and the site
  // and drive levels are plain directories; unlike onedrive there is
  // no aggregate-size root item.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot: boolean = true
  // stat and every read that can fill the cache stamp the item's cTag, the
  // read taking it before the bytes, so the gate compares like with like.
  override readonly readRevalidatable: boolean = true
  override readonly indexTtl: number = 86_400
  override readonly prompt: string = PROMPT
  override readonly accessor: SharePointAccessor
  private readonly config: SharePointConfig

  constructor(config: SharePointConfig) {
    super()
    this.config = config
    this.accessor = new SharePointAccessor(config)
  }

  override readonly readsRanges: boolean = true

  override readonly listsStats: boolean = true

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return readdir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return read(this.accessor, path)
    return read(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path)
  }

  override readStream(path: PathSpec): AsyncIterable<Uint8Array> {
    return readStream(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return exists(this.accessor, path)
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

  override rmdir(path: PathSpec): Promise<void> {
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

  override filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (!opts.wholeWord || this.config.contentSearch !== true) return Promise.resolve(null)
    return filesContaining(this.accessor, text, [path])
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): SharePointVFSState {
    const config: SharePointConfigRedacted = redactSharePointConfig(this.config)
    return { type: this.name, config }
  }
}
