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

import { PostgresAccessor } from '@struktoai/mirage-core/accessor/postgres'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { POSTGRES_COMMANDS } from '@struktoai/mirage-core/commands/builtin/postgres/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { PgDriver } from '@struktoai/mirage-core/core/postgres/_driver'
import { read as postgresRead } from '@struktoai/mirage-core/core/postgres/read'
import { readdir as postgresReaddir } from '@struktoai/mirage-core/core/postgres/readdir'
import { stat as postgresStat } from '@struktoai/mirage-core/core/postgres/stat'
import { POSTGRES_OPS } from '@struktoai/mirage-core/ops/postgres/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseResource } from '@struktoai/mirage-core/resource/base'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import {
  redactPostgresConfig,
  resolvePostgresConfig,
} from '@struktoai/mirage-core/resource/postgres/config'
import type {
  PostgresConfig,
  PostgresConfigRedacted,
  PostgresConfigResolved,
} from '@struktoai/mirage-core/resource/postgres/config'
import { POSTGRES_PROMPT } from '@struktoai/mirage-core/resource/postgres/prompt'
import { PathSpec, ResourceName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { NeonPgDriver } from './neon_driver.ts'

const resolvePostgresGlob = makeResolveGlob(postgresReaddir)

export interface PostgresResourceOptions {
  config: PostgresConfig
  prefix?: string
  driver?: PgDriver
}

export interface PostgresResourceState {
  type: string
  config: PostgresConfigRedacted
  needs_override: true
}

export class PostgresResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.POSTGRES
  readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  readonly prompt: string
  readonly config: PostgresConfigResolved
  readonly driver: PgDriver
  readonly accessor: PostgresAccessor

  constructor(options: PostgresResourceOptions | PostgresConfig) {
    super()
    const { config, prefix, driver } =
      'config' in options ? options : { config: options, prefix: undefined, driver: undefined }
    this.config = resolvePostgresConfig(config)
    this.driver = driver ?? new NeonPgDriver(this.config.dsn)
    this.accessor = new PostgresAccessor(this.driver, this.config)
    this.prompt = POSTGRES_PROMPT.replace('{prefix}', prefix ?? '')
  }

  override getState(): PostgresResourceState {
    return {
      type: this.kind,
      config: redactPostgresConfig(this.config),
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
  override loadState(_state: PostgresResourceState): Promise<void> {
    return Promise.resolve()
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  override async close(): Promise<void> {
    await this.driver.close()
    await super.close()
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
    return resolvePostgresGlob(this.accessor, effective, this.index)
  }
}
