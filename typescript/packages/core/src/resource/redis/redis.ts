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

import { RedisAccessor } from '../../accessor/redis.ts'
import { makeResolveGlob } from '../../commands/builtin/generic_bind/index.ts'
import { REDIS_COMMANDS } from '../../commands/builtin/redis/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import { appendBytes } from '../../core/redis/append.ts'
import { SCOPE_ERROR } from '../../core/redis/constants.ts'
import { copy as copyCore } from '../../core/redis/copy.ts'
import { create as createCore } from '../../core/redis/create.ts'
import { size as duSizeCore, entries as duEntriesCore } from '../../core/redis/du/index.ts'
import { exists as existsCore } from '../../core/redis/exists.ts'
import { find as findCore, type FindOptions as RedisFindOptions } from '../../core/redis/find.ts'
import { mkdir as mkdirCore } from '../../core/redis/mkdir.ts'
import { read as readCore } from '../../core/redis/read.ts'
import { readdir as readdirCore } from '../../core/redis/readdir.ts'
import { rename as renameCore } from '../../core/redis/rename.ts'
import { rmR as rmRCore } from '../../core/redis/rm.ts'
import { rmdir as rmdirCore } from '../../core/redis/rmdir.ts'
import { stat as statCore } from '../../core/redis/stat.ts'
import { stream as streamCore } from '../../core/redis/stream.ts'
import { truncate as truncateCore } from '../../core/redis/truncate.ts'
import { unlink as unlinkCore } from '../../core/redis/unlink.ts'
import { writeBytes as writeCore } from '../../core/redis/write.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { REDIS_OPS } from '../../ops/redis/index.ts'
import { PathSpec, ResourceName } from '../../types.ts'
import type { FileStat } from '../../types.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { BaseResource } from '../base.ts'
import type { FindOptions, Resource } from '../base.ts'
import { REDACTED_SECRET } from '../secrets.ts'
import { REDIS_PROMPT } from './prompt.ts'
import type { RedisStoreLike } from './store.ts'

const globCore = makeResolveGlob(readdirCore, SCOPE_ERROR)

export interface RedisResourceState {
  type: string
  config: {
    url: typeof REDACTED_SECRET
    keyPrefix: string
  }
  keyPrefix: string
  files: Record<string, Uint8Array>
  dirs: string[]
  attrs?: Record<string, Record<string, string>>
  modified?: Record<string, string>
}

/**
 * A redis keyspace mounted as a filesystem, over whatever store it is given.
 *
 * The runtime packages subclass this as `RedisResource`, only to build the store: node opens a
 * RESP client from a redis URL, the browser speaks Upstash's REST shape over
 * fetch. Everything a mount does, ops table and commands included, lives here
 * once, because none of it depends on the transport.
 */
export class RedisResourceBase extends BaseResource implements Resource {
  readonly kind: string = ResourceName.REDIS
  readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  readonly prompt: string = REDIS_PROMPT
  readonly store: RedisStoreLike
  readonly accessor: RedisAccessor

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
    rm_recursive: rmRCore,
    du_size: duSizeCore,
    du_entries: duEntriesCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
    append: appendBytes,
  }

  constructor(store: RedisStoreLike) {
    super()
    this.store = store
    this.accessor = new RedisAccessor(store)
  }

  get url(): string {
    return this.store.url
  }

  get keyPrefix(): string {
    return this.store.keyPrefix
  }

  // The server URL (host, port and db) plus the key prefix pin the keyspace
  // two mounts would share. The prefix is joined path-like so nested
  // prefixes collapse onto one key.
  override storageId(): string {
    const prefix = stripSlash(this.keyPrefix)
    const base = `${this.kind}:${this.url}`
    return prefix === '' ? base : `${base}/${prefix}`
  }

  open(): Promise<void> {
    return this.store.open()
  }

  override async close(): Promise<void> {
    await this.store.close()
    await super.close()
  }

  ops(): readonly RegisteredOp[] {
    return REDIS_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return REDIS_COMMANDS
  }

  streamPath(p: PathSpec): AsyncIterable<Uint8Array> {
    return streamCore(this.accessor, p)
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return readCore(this.accessor, p)
  }

  writeFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return writeCore(this.accessor, p, data)
  }

  appendFile(p: PathSpec, data: Uint8Array): Promise<void> {
    return appendBytes(this.accessor, p, data)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return readdirCore(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return statCore(this.accessor, p)
  }

  exists(p: PathSpec): Promise<boolean> {
    return existsCore(this.accessor, p)
  }

  mkdir(p: PathSpec, options?: { recursive?: boolean }): Promise<void> {
    return mkdirCore(this.accessor, p, options?.recursive === true)
  }

  rmdir(p: PathSpec): Promise<void> {
    return rmdirCore(this.accessor, p)
  }

  unlink(p: PathSpec): Promise<void> {
    return unlinkCore(this.accessor, p)
  }

  rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return renameCore(this.accessor, src, dst)
  }

  truncate(p: PathSpec, length: number): Promise<void> {
    return truncateCore(this.accessor, p, length)
  }

  copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return copyCore(this.accessor, src, dst)
  }

  rmR(p: PathSpec): Promise<void> {
    return rmRCore(this.accessor, p)
  }

  du(p: PathSpec): Promise<number> {
    return duSizeCore(this.accessor, p)
  }

  find(p: PathSpec, options: FindOptions = {}): Promise<string[]> {
    return findCore(this.accessor, p, options as RedisFindOptions)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective = prefix
      ? paths.map((p) =>
          mountPrefixOf(p.virtual, p.resourcePath)
            ? p
            : new PathSpec({
                virtual: p.virtual,
                directory: p.directory,
                ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                resolved: p.resolved,
                resourcePath: mountKey(p.virtual, prefix),
              }),
        )
      : paths
    return globCore(this.accessor, effective, this.index)
  }

  override async getState(): Promise<RedisResourceState> {
    const files: Record<string, Uint8Array> = {}
    for (const key of await this.store.listFiles()) {
      const data = await this.store.getFile(key)
      if (data !== null) files[key] = data
    }
    const dirs = [...(await this.store.listDirs())].sort(compareCodePoints)
    return {
      type: this.kind,
      config: {
        url: REDACTED_SECRET,
        keyPrefix: this.keyPrefix,
      },
      keyPrefix: this.keyPrefix,
      files,
      dirs,
      attrs: await this.store.listAttrs(),
      modified: await this.store.listModified(),
    }
  }

  override loadState(state: RedisResourceState): Promise<void> {
    return this.store.restore({
      files: state.files,
      dirs: state.dirs,
      attrs: state.attrs ?? {},
      modified: state.modified ?? {},
    })
  }
}
