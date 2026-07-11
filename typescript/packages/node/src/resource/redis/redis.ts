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

import {
  BaseResource,
  PathSpec,
  REDACTED_SECRET,
  ResourceName,
  mountKey,
  mountPrefixOf,
  type FileStat,
  type FindOptions,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { REDIS_COMMANDS } from '../../commands/builtin/redis/index.ts'
import type { RedisClientType } from 'redis'
import { RedisAccessor } from '../../accessor/redis.ts'
import { appendBytes } from '../../core/redis/append.ts'
import { copy as copyCore } from '../../core/redis/copy.ts'
import { create as createCore } from '../../core/redis/create.ts'
import { du as duCore, duAll as duAllCore } from '../../core/redis/du.ts'
import { exists as existsCore } from '../../core/redis/exists.ts'
import { find as findCore, type FindOptions as RedisFindOptions } from '../../core/redis/find.ts'
import { resolveGlob as globCore } from '../../core/redis/glob.ts'
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
import { REDIS_OPS } from '../../ops/redis/index.ts'
import { REDIS_PROMPT } from './prompt.ts'
import { RedisStore } from './store.ts'

export interface RedisResourceOptions {
  url?: string
  keyPrefix?: string
}

export interface RedisModule {
  createClient: (options: { url: string }) => RedisClientType
  RESP_TYPES: { readonly BLOB_STRING: number }
}

export interface RedisResourceState {
  type: string
  config: {
    url: typeof REDACTED_SECRET
    keyPrefix: string
  }
  keyPrefix: string
  files: Record<string, Uint8Array>
  dirs: string[]
}

export class RedisResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.REDIS
  readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  readonly prompt: string = REDIS_PROMPT
  readonly url: string
  readonly keyPrefix: string
  readonly store: RedisStore
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
    du_total: duCore,
    du_all: duAllCore,
    create: createCore,
    truncate: truncateCore,
    exists: existsCore,
    find_flat: findCore,
    append: appendBytes,
  }

  constructor(options: RedisResourceOptions = {}) {
    super()
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.keyPrefix = options.keyPrefix ?? 'mirage:fs:'
    this.store = new RedisStore({ url: this.url, keyPrefix: this.keyPrefix })
    this.accessor = new RedisAccessor(this.store)
  }

  async open(): Promise<void> {
    await this.store.client()
  }

  close(): Promise<void> {
    return this.store.close()
  }

  client(): Promise<RedisClientType> {
    return this.store.client()
  }

  protected module(): Promise<RedisModule> {
    return import('redis') as unknown as Promise<RedisModule>
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
    return duCore(this.accessor, p)
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

  async getState(): Promise<RedisResourceState> {
    const files: Record<string, Uint8Array> = {}
    for (const key of await this.store.listFiles()) {
      const data = await this.store.getFile(key)
      if (data !== null) files[key] = data
    }
    const dirs = [...(await this.store.listDirs())].sort()
    return {
      type: this.kind,
      config: {
        url: REDACTED_SECRET,
        keyPrefix: this.keyPrefix,
      },
      keyPrefix: this.keyPrefix,
      files,
      dirs,
    }
  }

  async loadState(state: RedisResourceState): Promise<void> {
    const c = await this.store.client()
    const pipe = c.multi()
    const dirKey = `${this.keyPrefix}dir`
    for (const [path, data] of Object.entries(state.files)) {
      pipe.set(
        `${this.keyPrefix}file:${path}`,
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      )
    }
    for (const dir of state.dirs) {
      pipe.sAdd(dirKey, dir)
    }
    await pipe.exec()
  }
}
