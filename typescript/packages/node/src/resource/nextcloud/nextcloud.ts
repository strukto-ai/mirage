import {
  BaseResource,
  makeResolveGlob,
  mountKey,
  mountPrefixOf,
  PathSpec,
  ResourceName,
  type FileStat,
  type FindOptions,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { NEXTCLOUD_COMMANDS } from '../../commands/builtin/nextcloud/index.ts'
import { SCOPE_ERROR } from '../../core/nextcloud/constants.ts'
import { copy as copyCore } from '../../core/nextcloud/copy.ts'
import { create as createCore } from '../../core/nextcloud/create.ts'
import { du as duCore, duAll as duAllCore } from '../../core/nextcloud/du.ts'
import { exists as existsCore } from '../../core/nextcloud/exists.ts'
import { find as findCore } from '../../core/nextcloud/find.ts'
import { mkdir as mkdirCore } from '../../core/nextcloud/mkdir.ts'
import { read as readCore } from '../../core/nextcloud/read.ts'
import { readdir as readdirCore } from '../../core/nextcloud/readdir.ts'
import { rename as renameCore } from '../../core/nextcloud/rename.ts'
import { rmR as rmRCore } from '../../core/nextcloud/rm.ts'
import { rmdir as rmdirCore } from '../../core/nextcloud/rmdir.ts'
import { stat as statCore } from '../../core/nextcloud/stat.ts'
import { rangeRead as rangeReadCore, stream as streamCore } from '../../core/nextcloud/stream.ts'
import { truncate as truncateCore } from '../../core/nextcloud/truncate.ts'
import { unlink as unlinkCore } from '../../core/nextcloud/unlink.ts'
import { write as writeCore } from '../../core/nextcloud/write.ts'
import { NEXTCLOUD_OPS } from '../../ops/nextcloud/index.ts'
import {
  redactNextcloudConfig,
  type NextcloudConfig,
  type NextcloudConfigRedacted,
} from './config.ts'
import { NEXTCLOUD_PROMPT } from './prompt.ts'

const resolveGlobCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export interface NextcloudResourceState {
  type: string
  config: NextcloudConfigRedacted
}

export class NextcloudResource extends BaseResource implements Resource {
  readonly kind = ResourceName.NEXTCLOUD
  readonly cachesReads = true
  readonly supportsSnapshot = true
  readonly prompt = NEXTCLOUD_PROMPT
  readonly accessor: NextcloudAccessor
  readonly opsMap: Record<string, unknown> = {
    read_bytes: readCore,
    write: writeCore,
    readdir: readdirCore,
    stat: statCore,
    unlink: unlinkCore,
    rmdir: rmdirCore,
    copy: copyCore,
    rename: renameCore,
    mkdir: mkdirCore,
    read_stream: streamCore,
    range_read: rangeReadCore,
    rm_recursive: rmRCore,
    du_total: duCore,
    du_all: duAllCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
  }

  constructor(readonly config: NextcloudConfig) {
    super()
    this.accessor = new NextcloudAccessor(config)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return NEXTCLOUD_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return NEXTCLOUD_OPS
  }

  streamPath(path: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, path, this.index)
  }

  readFile(path: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, path, this.index)
  }

  writeFile(path: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, path, data, this.index)
  }

  async appendFile(path: PathSpec, data: Uint8Array): Promise<void> {
    let existing: Uint8Array
    try {
      existing = await readCore(this.accessor, path, this.index)
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error
      existing = new Uint8Array()
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength)
    merged.set(existing)
    merged.set(data, existing.byteLength)
    await writeCore(this.accessor, path, merged, this.index)
  }

  readdir(path: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, path, this.index)
  }

  stat(path: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, path, this.index)
  }

  exists(path: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, path)
  }

  mkdir(path: PathSpec): Promise<void> {
    return mkdirCore(this.accessor, path)
  }

  rmdir(path: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, path)
  }

  unlink(path: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, path)
  }

  rename(source: PathSpec, destination: PathSpec): Promise<void> {
    return renameCore(this.accessor, source, destination)
  }

  truncate(path: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, path, length)
  }

  copy(source: PathSpec, destination: PathSpec): Promise<void> {
    return copyCore(this.accessor, source, destination)
  }

  rmR(path: PathSpec): Promise<void> {
    return rmRCore(this.accessor, path)
  }

  du(path: PathSpec): Promise<number> {
    return duCore(this.accessor, path)
  }

  find(path: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, path, options)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((path) =>
          mountPrefixOf(path.virtual, path.resourcePath)
            ? path
            : new PathSpec({
                virtual: path.virtual,
                directory: path.directory,
                ...(path.pattern !== null ? { pattern: path.pattern } : {}),
                resolved: path.resolved,
                resourcePath: mountKey(path.virtual, prefix),
              }),
        )
      : paths
    return resolveGlobCore(this.accessor, effective, this.index)
  }

  getState(): Promise<NextcloudResourceState> {
    return Promise.resolve({ type: this.kind, config: redactNextcloudConfig(this.config) })
  }

  loadState(_state: NextcloudResourceState): Promise<void> {
    return Promise.resolve()
  }
}
