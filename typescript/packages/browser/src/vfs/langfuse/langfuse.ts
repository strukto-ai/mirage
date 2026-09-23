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

import { LangfuseAccessor } from '@struktoai/mirage-core/accessor/langfuse'
import { makeResolveGlob } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { LANGFUSE_COMMANDS } from '@struktoai/mirage-core/commands/builtin/langfuse/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { HttpLangfuseTransport } from '@struktoai/mirage-core/core/langfuse/client'
import { read as langfuseRead } from '@struktoai/mirage-core/core/langfuse/read'
import { readdir as langfuseReaddir } from '@struktoai/mirage-core/core/langfuse/readdir'
import { stat as langfuseStat } from '@struktoai/mirage-core/core/langfuse/stat'
import { LANGFUSE_OPS } from '@struktoai/mirage-core/ops/langfuse/index'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { LANGFUSE_PROMPT } from '@struktoai/mirage-core/vfs/langfuse/prompt'
import { PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { mountKey, mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { redactLangfuseConfig, type LangfuseConfig, type LangfuseConfigRedacted } from './config.ts'

const resolveLangfuseGlob = makeResolveGlob(langfuseReaddir)

export interface LangfuseVFSState {
  type: string
  config: LangfuseConfigRedacted
}

export class LangfuseVFS extends BaseVFS implements VFS {
  readonly kind: string = VFSName.LANGFUSE
  readonly cachesReads: boolean = true
  override readonly indexTtl: number = 600
  readonly prompt: string = LANGFUSE_PROMPT
  readonly config: LangfuseConfig
  readonly accessor: LangfuseAccessor

  constructor(config: LangfuseConfig) {
    super()
    this.config = config
    const transportOpts: { publicKey: string; secretKey: string; host?: string } = {
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    }
    if (config.host !== undefined) transportOpts.host = config.host
    const accessorConfig: {
      defaultTraceLimit?: number
      defaultSearchLimit?: number
      defaultFromTimestamp?: string
    } = {}
    if (config.defaultTraceLimit !== undefined) {
      accessorConfig.defaultTraceLimit = config.defaultTraceLimit
    }
    if (config.defaultSearchLimit !== undefined) {
      accessorConfig.defaultSearchLimit = config.defaultSearchLimit
    }
    if (config.defaultFromTimestamp !== undefined) {
      accessorConfig.defaultFromTimestamp = config.defaultFromTimestamp
    }
    this.accessor = new LangfuseAccessor(new HttpLangfuseTransport(transportOpts), accessorConfig)
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return LANGFUSE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LANGFUSE_OPS
  }

  readFile(p: PathSpec): Promise<Uint8Array> {
    return langfuseRead(this.accessor, p, this.index)
  }

  readdir(p: PathSpec): Promise<string[]> {
    return langfuseReaddir(this.accessor, p, this.index)
  }

  stat(p: PathSpec): Promise<FileStat> {
    return langfuseStat(this.accessor, p, this.index)
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
    return resolveLangfuseGlob(this.accessor, effective, this.index)
  }

  override getState(): Promise<LangfuseVFSState> {
    return Promise.resolve({
      type: this.kind,
      config: redactLangfuseConfig(this.config),
    })
  }

  override loadState(_state: LangfuseVFSState): Promise<void> {
    return Promise.resolve()
  }
}
