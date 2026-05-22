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
  PathSpec,
  POSTGRES_COMMANDS,
  POSTGRES_OPS,
  POSTGRES_PROMPT,
  PostgresAccessor,
  type PostgresConfig,
  type PostgresConfigResolved,
  postgresRead,
  postgresReaddir,
  postgresStat,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  resolvePostgresConfig,
  resolvePostgresGlob,
} from '@struktoai/mirage-core'
import { PostgresStore } from './store.ts'

export interface PostgresResourceOptions {
  config: PostgresConfig
  prefix?: string
}

export class PostgresResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.POSTGRES
  readonly isRemote: boolean = true
  readonly indexTtl: number = 0
  readonly prompt: string
  readonly config: PostgresConfigResolved
  readonly store: PostgresStore
  readonly accessor: PostgresAccessor

  constructor(options: PostgresResourceOptions | PostgresConfig) {
    super()
    const { config, prefix } =
      'config' in options ? options : { config: options, prefix: undefined }
    this.config = resolvePostgresConfig(config)
    this.store = new PostgresStore(this.config)
    this.accessor = new PostgresAccessor(this.store, this.config)
    this.prompt = POSTGRES_PROMPT.replace('{prefix}', prefix ?? '')
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    await this.store.close()
  }

  ops(): readonly RegisteredOp[] {
    return POSTGRES_OPS
  }

  commands(): readonly RegisteredCommand[] {
    return POSTGRES_COMMANDS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return postgresRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return postgresReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return postgresStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            p.prefix !== ''
              ? p
              : new PathSpec({
                  original: p.original,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  prefix,
                }),
          )
        : paths
    return resolvePostgresGlob(this.accessor, effective, this.index)
  }
}
