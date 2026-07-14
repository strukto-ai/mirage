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
  type FileStat,
  LANCEDB_COMMANDS,
  LANCEDB_OPS,
  LANCEDB_PROMPT,
  LanceDBAccessor,
  type LanceDBConfig,
  type LanceDBConfigResolved,
  lanceRead,
  lanceReaddir,
  lanceStat,
  type PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  resolveLanceDBConfig,
} from '@struktoai/mirage-core'
import { LanceDBStore } from './store.ts'

const REMOTE_SCHEMES = ['s3://', 'gs://', 'az://', 'hf://', 'db://']

export interface LanceDBResourceOptions {
  config: LanceDBConfig
}

export class LanceDBResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.LANCEDB
  readonly cachesReads: boolean
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

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.store.close()
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
