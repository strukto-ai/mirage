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

import { JaegerAccessor } from '@struktoai/mirage-core/accessor/jaeger'
import { JAEGER_COMMANDS } from '@struktoai/mirage-core/commands/builtin/jaeger/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpJaegerTransport } from '@struktoai/mirage-core/core/jaeger/client'
import { JAEGER_OPS } from '@struktoai/mirage-core/ops/jaeger/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { JAEGER_PROMPT } from '@struktoai/mirage-core/vfs/jaeger/prompt'
import { VFSName } from '@struktoai/mirage-core/types'
import { redactJaegerConfig, type JaegerConfig, type JaegerConfigRedacted } from './config.ts'
export interface JaegerVFSState {
  type: string
  config: JaegerConfigRedacted
}

export class JaegerVFS extends BaseVFS {
  override readonly name: string = VFSName.JAEGER
  override readonly cachesReads: boolean = true
  // Every listed file carries an exact size: a trace is rendered at readdir
  // from the search payload the listing already fetched, and operations.json
  // is sized by one call per service directory the caller opens.
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  override readonly prompt: string = JAEGER_PROMPT
  readonly config: JaegerConfig
  override readonly accessor: JaegerAccessor

  constructor(config: JaegerConfig) {
    super()
    this.config = config
    const transportOpts: { host?: string; timeout?: number } = {}
    if (config.host !== undefined) transportOpts.host = config.host
    if (config.requestTimeout !== undefined) transportOpts.timeout = config.requestTimeout
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultFromTimestamp?: string
      defaultToTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    if (config.defaultToTimestamp !== undefined) {
      accessorConfig.defaultToTimestamp = config.defaultToTimestamp
    }
    this.accessor = new JaegerAccessor(new HttpJaegerTransport(transportOpts), accessorConfig)
  }
  override commands(): readonly RegisteredCommand[] {
    return JAEGER_COMMANDS
  }

  override ops(): readonly RegisteredOp[] {
    return JAEGER_OPS
  }
  override getState(): Promise<JaegerVFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactJaegerConfig(this.config),
    })
  }

  override loadState(_state: JaegerVFSState): Promise<void> {
    return Promise.resolve()
  }
}
