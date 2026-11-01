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

import { MongoDBAccessor } from '@struktoai/mirage-core/accessor/mongodb'
import { VFSName } from '@struktoai/mirage-core/types'
import type { MongoDBConfig } from '@struktoai/mirage-core/vfs/mongodb/config'
import {
  redactMongoDBConfig,
  resolveMongoDBConfig,
} from '@struktoai/mirage-core/vfs/mongodb/config'
import { MongoDBVFS as CoreMongoDBVFS, VFS_MD } from '@struktoai/mirage-core/vfs/mongodb/mongodb'
import type { ConfigState } from '@struktoai/mirage-core/vfs/types'
import { MongoDBStore } from './store.ts'

export interface MongoDBVFSOptions {
  config: MongoDBConfig
  prefix?: string
}

export class MongoDBVFS extends CoreMongoDBVFS {
  override readonly name: string = VFSName.MONGODB
  override readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  override vfsMd: string
  readonly config: ReturnType<typeof resolveMongoDBConfig>
  readonly store: MongoDBStore
  override readonly accessor: MongoDBAccessor

  constructor(options: MongoDBVFSOptions | MongoDBConfig) {
    super()
    const { config, prefix } =
      'config' in options ? options : { config: options, prefix: undefined }
    this.config = resolveMongoDBConfig(config)
    this.store = new MongoDBStore(this.config.uri, this.config.timeout)
    this.accessor = new MongoDBAccessor(this.store, this.config)
    this.vfsMd = prefix === undefined ? VFS_MD : VFS_MD.replace('{prefix}', prefix)
  }

  override getState(): ConfigState<ReturnType<typeof redactMongoDBConfig>> & {
    needs_override: true
  } {
    return {
      type: this.name,
      config: redactMongoDBConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMVFS for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python rebuilds via its registry, so it
      // writes this on only four mounts and reads it nowhere.
      needs_override: true,
    }
  }

  override async close(): Promise<void> {
    await this.store.close()
    await super.close()
  }
}
