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
  HttpLangfuseTransport,
  LANGFUSE_COMMANDS,
  LANGFUSE_PROMPT,
  LANGFUSE_VFS_OPS,
  LangfuseAccessor,
  langfuseRead,
  langfuseReaddir,
  langfuseStat,
  PathSpec,
  type RegisteredCommand,
  type RegisteredOp,
  type Resource,
  ResourceName,
  resolveLangfuseGlob,
} from '@struktoai/mirage-core'
import { redactLangfuseConfig, type LangfuseConfig, type LangfuseConfigRedacted } from './config.ts'

export interface LangfuseResourceState {
  type: string
  needsOverride: boolean
  redactedFields: readonly string[]
  config: LangfuseConfigRedacted
}

export class LangfuseResource extends BaseResource implements Resource {
  readonly kind: string = ResourceName.LANGFUSE
  readonly isRemote: boolean = true
  readonly indexTtl: number = 600
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

  close(): Promise<void> {
    return Promise.resolve()
  }

  commands(): readonly RegisteredCommand[] {
    return LANGFUSE_COMMANDS
  }

  ops(): readonly RegisteredOp[] {
    return LANGFUSE_VFS_OPS
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

  fingerprint(_p: PathSpec): Promise<string | null> {
    return Promise.resolve(null)
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
    return resolveLangfuseGlob(this.accessor, effective, this.index)
  }

  getState(): Promise<LangfuseResourceState> {
    return Promise.resolve({
      type: this.kind,
      needsOverride: true,
      redactedFields: ['secretKey'],
      config: redactLangfuseConfig(this.config),
    })
  }

  loadState(_state: LangfuseResourceState): Promise<void> {
    return Promise.resolve()
  }
}
