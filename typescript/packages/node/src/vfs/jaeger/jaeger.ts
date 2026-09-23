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
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { JAEGER_COMMANDS } from '@struktoai/mirage-core/commands/builtin/jaeger/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpJaegerTransport } from '@struktoai/mirage-core/core/jaeger/client'
import { read as jaegerRead } from '@struktoai/mirage-core/core/jaeger/read'
import { readdir as jaegerReaddir } from '@struktoai/mirage-core/core/jaeger/readdir'
import { stat as jaegerStat } from '@struktoai/mirage-core/core/jaeger/stat'
import { JAEGER_OPS } from '@struktoai/mirage-core/ops/jaeger/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { JAEGER_PROMPT } from '@struktoai/mirage-core/vfs/jaeger/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { redactJaegerConfig, type JaegerConfig, type JaegerConfigRedacted } from './config.ts'

const resolveJaegerGlob = makeResolveGlob(jaegerReaddir)

export interface JaegerVFSState {
  type: string
  config: JaegerConfigRedacted
}

export class JaegerVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.JAEGER
  readonly cachesReads: boolean = true
  // Every listed file carries an exact size: a trace is rendered at readdir
  // from the search payload the listing already fetched, and operations.json
  // is sized by one call per service directory the caller opens.
  readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = JAEGER_PROMPT
  readonly config: JaegerConfig
  readonly accessor: JaegerAccessor

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

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return JAEGER_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return JAEGER_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return jaegerRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return jaegerReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return jaegerStat(this.accessor, p, this.index)
  }

  glob(paths: readonly PathSpec[], prefix = ''): Promise<PathSpec[]> {
    const effective =
      prefix !== ''
        ? paths.map((p) =>
            mountPrefixOf(p.virtual, p.vfsPath) !== ''
              ? p
              : new PathSpec({
                  virtual: p.virtual,
                  directory: p.directory,
                  ...(p.pattern !== null ? { pattern: p.pattern } : {}),
                  resolved: p.resolved,
                  vfsPath: mountKey(p.virtual, prefix),
                }),
          )
        : paths
    return resolveJaegerGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<JaegerVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactJaegerConfig(this.config),
    })
  }

  override loadState(_state: JaegerVFSState): Promise<void> {
    return Promise.resolve()
  }
}
