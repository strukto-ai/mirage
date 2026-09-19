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
import { POSTGRES_COMMANDS } from '@struktoai/mirage-core/commands/builtin/postgres/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { PgDriver } from '@struktoai/mirage-core/core/postgres/_driver'
import { POSTGRES_OPS } from '@struktoai/mirage-core/ops/postgres/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import {
  redactPostgresConfig,
  resolvePostgresConfig,
} from '@struktoai/mirage-core/vfs/postgres/config'
import type {
  PostgresConfig,
  PostgresConfigRedacted,
  PostgresConfigResolved,
} from '@struktoai/mirage-core/vfs/postgres/config'
import { POSTGRES_PROMPT } from '@struktoai/mirage-core/vfs/postgres/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import { NeonPgDriver } from './neon_driver.ts'
export interface PostgresVFSOptions {
  config: PostgresConfig
  prefix?: string
  driver?: PgDriver
}

export interface PostgresVFSState {
  type: string
  config: PostgresConfigRedacted
  needs_override: true
}

export class PostgresVFS extends BaseVFS {
  override readonly name: string = VFSName.POSTGRES
  override readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  override readonly prompt: string
  readonly config: PostgresConfigResolved
  readonly driver: PgDriver
  override readonly accessor: PostgresAccessor

  constructor(options: PostgresVFSOptions | PostgresConfig) {
    super()
    const { config, prefix, driver } =
      'config' in options ? options : { config: options, prefix: undefined, driver: undefined }
    this.config = resolvePostgresConfig(config)
    this.driver = driver ?? new NeonPgDriver(this.config.dsn)
    this.accessor = new PostgresAccessor(this.driver, this.config)
    this.prompt = POSTGRES_PROMPT.replace('{prefix}', prefix ?? '')
  }

  override getState(): PostgresVFSState {
    return {
      type: this.name,
      config: redactPostgresConfig(this.config),
      // TypeScript cannot rebuild a config-backed mount from state:
      // `buildMountArgs` substitutes a RAMVFS for anything it was
      // not handed. Saying so out loud turns a silently empty mount
      // into a refusal to load. Python rebuilds via its registry, so it
      // writes this on only four mounts and reads it nowhere.
      needs_override: true,
    }
  }

  // The rows live in the database, so a restored mount reaches them
  // through its config alone — there is nothing to take back.
  override loadState(_state: PostgresVFSState): Promise<void> {
    return Promise.resolve()
  }
  override async close(): Promise<void> {
    await this.driver.close()
    await super.close()
  }

  override ops(): readonly RegisteredOp[] {
    return POSTGRES_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return POSTGRES_COMMANDS
  }
}
