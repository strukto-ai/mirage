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

import { ResourceName, type RegisteredCommand, type RegisteredOp } from '@struktoai/mirage-core'
import { S3Resource } from '../s3/s3.ts'
import {
  redactSupabaseConfig,
  supabaseToS3Config,
  type SupabaseConfig,
  type SupabaseConfigRedacted,
} from './config.ts'
import { SUPABASE_PROMPT } from './prompt.ts'

export interface SupabaseResourceState {
  type: string
  config: SupabaseConfigRedacted
}

function remapOpsResource(ops: readonly RegisteredOp[], to: string): RegisteredOp[] {
  return ops.map((op) => (op.resource === ResourceName.S3 ? { ...op, resource: to } : op))
}

function remapCommandsResource(
  commands: readonly RegisteredCommand[],
  to: string,
): RegisteredCommand[] {
  return commands.map((cmd) => {
    if (cmd.resource !== ResourceName.S3) return cmd
    const proto = Object.getPrototypeOf(cmd) as object
    const copy = Object.assign(Object.create(proto) as RegisteredCommand, cmd)
    Object.assign(copy, { resource: to })
    return copy
  })
}

export class SupabaseResource extends S3Resource {
  override readonly kind: string = ResourceName.SUPABASE
  override readonly prompt: string = SUPABASE_PROMPT
  readonly supabaseConfig: SupabaseConfig
  private readonly supabaseOps: readonly RegisteredOp[]
  private readonly supabaseCommands: readonly RegisteredCommand[]

  constructor(config: SupabaseConfig) {
    super(supabaseToS3Config(config))
    this.supabaseConfig = config
    this.supabaseOps = remapOpsResource(super.ops(), ResourceName.SUPABASE)
    this.supabaseCommands = remapCommandsResource(super.commands(), ResourceName.SUPABASE)
  }

  override ops(): readonly RegisteredOp[] {
    return this.supabaseOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.supabaseCommands
  }

  override getState(): Promise<SupabaseResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactSupabaseConfig(this.supabaseConfig),
    })
  }

  override loadState(_state: SupabaseResourceState): Promise<void> {
    return Promise.resolve()
  }
}
