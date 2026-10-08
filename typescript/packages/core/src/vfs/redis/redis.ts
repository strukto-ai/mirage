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
import { VFSName } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { BaseVFS } from '../base.ts'
import { REDACTED_SECRET } from '../secrets.ts'
import { PROMPT } from './prompt.ts'
import type { RedisStoreLike } from './store.ts'
import type { PathSpec, FileStat, SetAttrFields } from '../../types.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../base.ts'
import type { DuEntries } from '../types.ts'
import { readdir as redisReaddir } from '../../core/redis/readdir.ts'
import { read as redisRead } from '../../core/redis/read.ts'
import { stat as redisStat } from '../../core/redis/stat.ts'
import { readStream as redisStream } from '../../core/redis/stream.ts'
import { exists as redisExists } from '../../core/redis/exists.ts'
import { find as redisFind } from '../../core/redis/find.ts'
import { size as redisDu, entries as redisDuEntries } from '../../core/redis/du/index.ts'
import { write as redisWrite } from '../../core/redis/write.ts'
import { appendBytes as redisAppend } from '../../core/redis/append.ts'
import { create as redisCreate } from '../../core/redis/create.ts'
import { mkdir as redisMkdir } from '../../core/redis/mkdir.ts'
import { unlink as redisUnlink } from '../../core/redis/unlink.ts'
import { rmdir as redisRmdir } from '../../core/redis/rmdir.ts'
import { rmR as redisRmR } from '../../core/redis/rm.ts'
import { rename as redisRename } from '../../core/redis/rename.ts'
import { copy as redisCopy } from '../../core/redis/copy.ts'
import { truncate as redisTruncate } from '../../core/redis/truncate.ts'
import { setAttrs as redisSetAttrs } from '../../core/redis/set_attrs.ts'
import { SCOPE_ERROR } from '../../core/redis/constants.ts'
export interface RedisVFSState {
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
 * The runtime packages subclass this as `RedisVFS`, only to build the store: node opens a
 * RESP client from a redis URL, the browser speaks Upstash's REST shape over
 * fetch. Everything a mount does, ops table and commands included, lives here
 * once, because none of it depends on the transport.
 */
export class RedisResourceBase extends BaseVFS {
  override readonly name: string = VFSName.REDIS
  override readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  override readonly prompt: string = PROMPT
  readonly store: RedisStoreLike
  override readonly accessor: RedisAccessor
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
  override storageLocation(): string {
    const prefix = stripSlash(this.keyPrefix)
    const base = `${this.name}:${this.url}`
    return prefix === '' ? base : `${base}/${prefix}`
  }
  override async close(): Promise<void> {
    await this.store.close()
    await super.close()
  }

  override readonly readsRanges: boolean = true

  override readonly local: boolean = true

  override readonly maxGlobMatches: number = SCOPE_ERROR

  override readdir(path: PathSpec, index?: IndexCacheStore): Promise<string[]> {
    return redisReaddir(this.accessor, path, index)
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (offset === 0 && size === null) return redisRead(this.accessor, path, index)
    return redisRead(this.accessor, path, index, size === null ? { offset } : { offset, size })
  }

  override stat(path: PathSpec, index?: IndexCacheStore): Promise<FileStat> {
    return redisStat(this.accessor, path, index)
  }

  override readStream(path: PathSpec, index?: IndexCacheStore): AsyncIterable<Uint8Array> {
    return redisStream(this.accessor, path, index)
  }

  override exists(path: PathSpec): Promise<boolean> {
    return redisExists(this.accessor, path)
  }

  override find(path: PathSpec, options: FindOptions, _index?: IndexCacheStore): Promise<string[]> {
    return redisFind(this.accessor, path, options)
  }

  override duSize(path: PathSpec, _index?: IndexCacheStore): Promise<number> {
    return redisDu(this.accessor, path)
  }

  override duEntries(path: PathSpec, _index?: IndexCacheStore): Promise<DuEntries> {
    return redisDuEntries(this.accessor, path)
  }

  override write(path: PathSpec, data: Uint8Array): Promise<void> {
    return redisWrite(this.accessor, path, data)
  }

  override append(path: PathSpec, data: Uint8Array): Promise<void> {
    return redisAppend(this.accessor, path, data)
  }

  override create(path: PathSpec): Promise<void> {
    return redisCreate(this.accessor, path)
  }

  override mkdir(path: PathSpec, parents = false): Promise<void> {
    return redisMkdir(this.accessor, path, parents)
  }

  override unlink(path: PathSpec): Promise<void> {
    return redisUnlink(this.accessor, path)
  }

  override rmdir(path: PathSpec, _index?: IndexCacheStore): Promise<void> {
    return redisRmdir(this.accessor, path)
  }

  override rmR(path: PathSpec): Promise<void> {
    return redisRmR(this.accessor, path)
  }

  override rename(src: PathSpec, dst: PathSpec): Promise<void> {
    return redisRename(this.accessor, src, dst)
  }

  override copy(src: PathSpec, dst: PathSpec): Promise<void> {
    return redisCopy(this.accessor, src, dst)
  }

  override truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    return redisTruncate(this.accessor, path, length, noCreate)
  }

  override setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return redisSetAttrs(this.accessor, path, fields)
  }

  override async getState(): Promise<RedisVFSState> {
    const files: Record<string, Uint8Array> = {}
    for (const key of await this.store.listFiles()) {
      const data = await this.store.getFile(key)
      if (data !== null) files[key] = data
    }
    const dirs = [...(await this.store.listDirs())].sort(compareCodePoints)
    return {
      type: this.name,
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

  override loadState(state: RedisVFSState): Promise<void> {
    return this.store.restore({
      files: state.files,
      dirs: state.dirs,
      attrs: state.attrs ?? {},
      modified: state.modified ?? {},
    })
  }
}
