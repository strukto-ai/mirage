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
import { ociToS3Config, redactOciConfig, type OCIConfig, type OCIConfigRedacted } from './config.ts'
import { OCI_PROMPT } from './prompt.ts'

export interface OCIResourceState {
  type: string
  config: OCIConfigRedacted
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

export class OCIResource extends S3Resource {
  override readonly kind: string = ResourceName.OCI
  override readonly prompt: string = OCI_PROMPT
  readonly ociConfig: OCIConfig
  private readonly ociOps: readonly RegisteredOp[]
  private readonly ociCommands: readonly RegisteredCommand[]

  constructor(config: OCIConfig) {
    super(ociToS3Config(config))
    this.ociConfig = config
    this.ociOps = remapOpsResource(super.ops(), ResourceName.OCI)
    this.ociCommands = remapCommandsResource(super.commands(), ResourceName.OCI)
  }

  override ops(): readonly RegisteredOp[] {
    return this.ociOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.ociCommands
  }

  override getState(): Promise<OCIResourceState> {
    return Promise.resolve({
      type: this.kind,
      config: redactOciConfig(this.ociConfig),
    })
  }

  override loadState(_state: OCIResourceState): Promise<void> {
    return Promise.resolve()
  }
}
