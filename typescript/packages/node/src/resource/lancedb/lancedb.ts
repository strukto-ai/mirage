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

import { LanceDBAccessor } from '@struktoai/mirage-core/accessor/lancedb'
import { LANCEDB_COMMANDS } from '@struktoai/mirage-core/commands/builtin/lancedb/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { read as lanceRead } from '@struktoai/mirage-core/core/lancedb/read'
import { readdir as lanceReaddir } from '@struktoai/mirage-core/core/lancedb/readdir'
import { stat as lanceStat } from '@struktoai/mirage-core/core/lancedb/stat'
import { LANCEDB_OPS } from '@struktoai/mirage-core/ops/lancedb/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseResource } from '@struktoai/mirage-core/resource/base'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import {
  redactLanceDBConfig,
  resolveLanceDBConfig,
} from '@struktoai/mirage-core/resource/lancedb/config'
import type {
  LanceDBConfig,
  LanceDBConfigRedacted,
  LanceDBConfigResolved,
} from '@struktoai/mirage-core/resource/lancedb/config'
import { LANCEDB_PROMPT } from '@struktoai/mirage-core/resource/lancedb/prompt'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { LanceDBStore } from './store.ts'

const REMOTE_SCHEMES = ['s3://', 'gs://', 'az://', 'hf://', 'db://']

export interface LanceDBResourceOptions {
  config: LanceDBConfig
}

export interface LanceDBResourceState {
  type: string
  config: LanceDBConfigRedacted
  needs_override: true
}

export class LanceDBResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.LANCEDB
  readonly cachesReads: boolean
  // readdir seeds exact card sizes from the widened select and stat falls
  // back to rendering the row itself, so sizes are exact either way.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 0
  readonly prompt: string = LANCEDB_PROMPT
  readonly config: LanceDBConfigResolved
  readonly store: LanceDBStore
  readonly accessor: LanceDBAccessor

  constructor(options: LanceDBResourceOptions | LanceDBConfig) {
    super()
    const config = 'config' in options ? options.config : options
    this.config = resolveLanceDBConfig(config)
    this.cachesReads = REMOTE_SCHEMES.some((scheme) => this.config.uri.startsWith(scheme))
    this.store = new LanceDBStore(this.config)
    this.accessor = new LanceDBAccessor(this.store, this.config)
  }

  override getState(): LanceDBResourceState {
    return {
      type: this.kind,
      config: redactLanceDBConfig(this.config),
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
  override loadState(_state: LanceDBResourceState): Promise<void> {
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
    return LANCEDB_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return LANCEDB_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return lanceRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return lanceReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return lanceStat(this.accessor, p, this.index)
  }
}
