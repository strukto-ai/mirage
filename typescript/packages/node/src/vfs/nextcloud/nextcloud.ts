import type { ByteSource } from '@struktoai/mirage-core/io/types'
import type {
  CapacityResult,
  FileStat,
  PathSpec,
  SetAttrFields,
} from '@struktoai/mirage-core/types'
import { VFSName } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { RedactedSchema } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigState, Handed } from '@struktoai/mirage-core/vfs/types'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { capacity } from '../../core/nextcloud/capacity.ts'
import { checksum } from '../../core/nextcloud/checksum.ts'
import { copy, dirCopy } from '../../core/nextcloud/copy.ts'
import { create } from '../../core/nextcloud/create.ts'
import { exists } from '../../core/nextcloud/exists.ts'
import { mkdir } from '../../core/nextcloud/mkdir.ts'
import { read } from '../../core/nextcloud/read.ts'
import { readdir } from '../../core/nextcloud/readdir.ts'
import { rename } from '../../core/nextcloud/rename.ts'
import { rmR } from '../../core/nextcloud/rm.ts'
import { rmdir } from '../../core/nextcloud/rmdir.ts'
import { setAttrs } from '../../core/nextcloud/set_attrs.ts'
import { stat, tree } from '../../core/nextcloud/stat.ts'
import { readStream } from '../../core/nextcloud/stream.ts'
import { truncate } from '../../core/nextcloud/truncate.ts'
import { unlink } from '../../core/nextcloud/unlink.ts'
import { write } from '../../core/nextcloud/write.ts'
import { NextcloudConfig } from './config.ts'

export class NextcloudVFS extends BaseVFS {
  override readonly name = VFSName.NEXTCLOUD
  override readonly cachesReads = true
  // WebDAV PROPFIND carries getcontentlength for every file; readdir
  // backfills any lister-omitted size with one stat per affected file.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly supportsSnapshot = true
  override readonly accessor: NextcloudAccessor

  constructor(readonly config: NextcloudConfig) {
    super()
    this.accessor = new NextcloudAccessor(config)
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

  override readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    return tree(this.accessor, path)
  }

  override checksum(path: PathSpec, algorithm: string): Promise<string | null> {
    return checksum(this.accessor, path, algorithm)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return exists(this.accessor, path)
  }

  override write(path: PathSpec, data: ByteSource): Promise<void> {
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
    return dirCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return truncate(this.accessor, path, length, noCreate)
  }

  override setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return setAttrs(this.accessor, path, fields)
  }

  override capacity(): Promise<CapacityResult> {
    return capacity(this.accessor)
  }

  override storageLocation(): string {
    // The server and the user pin the WebDAV tree two mounts would share:
    // each user's files live in a tree of their own.
    return `${this.name}:${rstripSlash(this.config.url)}:${this.config.username ?? ''}`
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof NextcloudConfig>>> {
    return Promise.resolve(this.configState(NextcloudConfig, this.config))
  }
}
