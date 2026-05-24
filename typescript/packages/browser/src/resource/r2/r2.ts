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
import { r2ToS3Config, redactR2Config, type R2Config, type R2ConfigRedacted } from './config.ts'
import { R2_BROWSER_PROMPT } from './prompt.ts'

export interface R2ResourceState {
  type: string
  config: R2ConfigRedacted
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

export class R2Resource extends S3Resource {
  override readonly kind: string = ResourceName.R2
  override readonly prompt: string = R2_BROWSER_PROMPT
  readonly r2Config: R2Config
  private readonly r2Ops: readonly RegisteredOp[]
  private readonly r2Commands: readonly RegisteredCommand[]

  constructor(config: R2Config) {
    super(r2ToS3Config(config))
    this.r2Config = config
    this.r2Ops = remapOpsResource(super.ops(), ResourceName.R2)
    this.r2Commands = remapCommandsResource(super.commands(), ResourceName.R2)
  }

  override ops(): readonly RegisteredOp[] {
    return this.r2Ops
  }

  override commands(): readonly RegisteredCommand[] {
    return this.r2Commands
  }

  override getState(): Promise<R2ResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactR2Config(this.r2Config),
    })
  }

  override loadState(_state: R2ResourceState): Promise<void> {
    return Promise.resolve()
  }
}
