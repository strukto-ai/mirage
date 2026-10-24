import { BaseVFS } from '../base.ts'
import {
  redactSharePointConfig,
  SharePointAccessor,
  type SharePointConfig,
  type SharePointConfigRedacted,
} from '../../accessor/sharepoint.ts'
import { VFSName } from '../../types.ts'
import type { DeltaHook } from '../../events/base.ts'
import { buildDeltaHook } from '../../core/sharepoint/events.ts'
import type { PathSpec, FileStat } from '../../types.ts'
import type { Handed } from '../types.ts'
import { readdir, tree } from '../../core/sharepoint/readdir.ts'
import { read } from '../../core/sharepoint/read.ts'
import { stat } from '../../core/sharepoint/stat.ts'
import { readStream } from '../../core/sharepoint/stream.ts'
import { exists } from '../../core/sharepoint/exists.ts'
import type { ByteSource } from '../../io/types.ts'
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
import { WALK_LIMIT } from '../constants.ts'

export const VFS_MD = `{prefix}
  SharePoint Enterprise document libraries. Multi-site, multi-drive discovery.
  Unscoped mounts use: /{site_name}/{library_name}/{path_to_file}
  Unscoped level 0 (ls /): lists all accessible SharePoint sites.
  Unscoped level 1 (ls /site/): lists document libraries (drives) in that site.
  Unscoped level 2+ (ls /site/lib/...): lists files and folders in the drive.
  IMPORTANT: This is a remote mount. Prefer targeted reads (grep, head) over full scans. Avoid cat on large files without piping to head/tail.
  File versions are retained, snapshots pin and read prior versions.`

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
  override vfsMd: string = VFS_MD
  override readonly wholeWordSearch: boolean = true
  override readonly accessor: SharePointAccessor
  private readonly config: SharePointConfig

  override readonly walkLimit: number

  constructor(config: SharePointConfig) {
    super()
    this.config = config
    this.walkLimit = config.walkLimit ?? WALK_LIMIT
    this.accessor = new SharePointAccessor(config)
  }

  override readonly readsRanges: boolean = true

  override readdir(path: PathSpec): Promise<FileStat[]> {
    return readdir(this.accessor, path)
  }

  override read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> | AsyncIterable<Uint8Array> {
    if (offset === 0 && size === null) return readStream(this.accessor, path)
    return read(this.accessor, path, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return stat(this.accessor, path)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return exists(this.accessor, path)
  }

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return tree(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource, signal?: AbortSignal): Promise<void> {
    return write(this.accessor, path, data, signal)
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
