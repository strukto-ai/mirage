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
import { REDIS_COMMANDS } from '../../commands/builtin/redis/index.ts'
import type { RegisteredCommand } from '../../commands/config.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { REDIS_OPS } from '../../ops/redis/index.ts'
import { VFSName } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { BaseVFS } from '../base.ts'
import { REDACTED_SECRET } from '../secrets.ts'
import { REDIS_PROMPT } from './prompt.ts'
import type { RedisStoreLike } from './store.ts'
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
  override readonly prompt: string = REDIS_PROMPT
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

  override ops(): readonly RegisteredOp[] {
    return REDIS_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return REDIS_COMMANDS
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
