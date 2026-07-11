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
  MONGODB_COMMANDS,
  MONGODB_OPS,
  MONGODB_PROMPT,
  MongoDBAccessor,
  PathSpec,
  ResourceName,
  detectMongoScope,
  mongoRead,
  mongoReaddir,
  mongoStat,
  mountKey,
  mountPrefixOf,
  resolveMongoDBConfig,
  resolveMongoGlob,
  type FileStat,
  type MongoDBConfig,
  type MongoDBConfigResolved,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
} from '@struktoai/mirage-core'
import { MongoDBStore } from './store.ts'

void detectMongoScope

export interface MongoDBResourceOptions {
  config: MongoDBConfig
  prefix?: string
}

export class MongoDBResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.MONGODB
  readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  readonly prompt: string
  readonly config: MongoDBConfigResolved
  readonly store: MongoDBStore
  readonly accessor: MongoDBAccessor

  constructor(options: MongoDBResourceOptions | MongoDBConfig) {
    super()
    const { config, prefix } =
      'config' in options ? options : { config: options, prefix: undefined }
    this.config = resolveMongoDBConfig(config)
    this.store = new MongoDBStore(this.config.uri)
    this.accessor = new MongoDBAccessor(this.store, this.config)
    this.prompt = MONGODB_PROMPT.replace('{prefix}', prefix ?? '')
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.store.close()
  }

  ops(): readonly RegisteredOp[] {
    return MONGODB_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return MONGODB_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return mongoRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return mongoReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return mongoStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.resourcePath) !== ''
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
    return resolveMongoGlob(this.accessor, effective, this.index)
  }
}
