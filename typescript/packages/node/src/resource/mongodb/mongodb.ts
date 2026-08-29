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
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { MONGODB_COMMANDS } from '@struktoai/mirage-core/commands/builtin/mongodb/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { read as mongoRead } from '@struktoai/mirage-core/core/mongodb/read'
import { readdir as mongoReaddir } from '@struktoai/mirage-core/core/mongodb/readdir'
import { detectScope as detectMongoScope } from '@struktoai/mirage-core/core/mongodb/scope'
import { stat as mongoStat } from '@struktoai/mirage-core/core/mongodb/stat'
import { MONGODB_OPS } from '@struktoai/mirage-core/ops/mongodb/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseResource } from '@struktoai/mirage-core/resource/base'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import {
  redactMongoDBConfig,
  resolveMongoDBConfig,
} from '@struktoai/mirage-core/resource/mongodb/config'
import type {
  MongoDBConfig,
  MongoDBConfigRedacted,
  MongoDBConfigResolved,
} from '@struktoai/mirage-core/resource/mongodb/config'
import { MONGODB_PROMPT } from '@struktoai/mirage-core/resource/mongodb/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { MongoDBStore } from './store.ts'

const resolveMongoGlob = makeResolveGlob(mongoReaddir)

void detectMongoScope

export interface MongoDBResourceOptions {
  config: MongoDBConfig
  prefix?: string
}

export interface MongoDBResourceState {
  type: string
  config: MongoDBConfigRedacted
  needs_override: true
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

  override getState(): MongoDBResourceState {
    return {
      type: this.kind,
      config: redactMongoDBConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMResource for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python reads the flag too now, and
      // writes it only where a rebuild really cannot work.
      needs_override: true,
    }
  }

  // The rows live in the database, so a restored mount reaches them
  // through its config alone — there is nothing to take back.
  override loadState(_state: MongoDBResourceState): Promise<void> {
    return Promise.resolve()
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  override async close(): Promise<void> {
    await this.store.close()
    await super.close()
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
