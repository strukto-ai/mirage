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

import { S3Accessor } from '@struktoai/mirage-core/accessor/s3'
import { S3_COMMANDS } from '@struktoai/mirage-core/commands/builtin/s3/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { S3_OPS } from '@struktoai/mirage-core/ops/s3/index'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import type { S3HttpAgents } from '@struktoai/mirage-core/vfs/s3/config'
import { S3_PROMPT } from '@struktoai/mirage-core/vfs/s3/prompt'
import { s3StorageLocation } from '@struktoai/mirage-core/vfs/s3/storage_id'
import { VFSName } from '@struktoai/mirage-core/types'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { redactConfig, type S3Config, type S3ConfigRedacted } from './config.ts'
import { buildDeltaHook } from '@struktoai/mirage-core/core/s3/watch'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
function createProxyAgents(proxy: string): S3HttpAgents {
  return { httpAgent: new HttpProxyAgent(proxy), httpsAgent: new HttpsProxyAgent(proxy) }
}

export interface S3VFSState {
  type: string
  config: S3ConfigRedacted
}

export class S3VFS extends BaseVFS {
  override readonly name: string = VFSName.S3
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 600
  override readonly prompt: string = S3_PROMPT
  readonly config: S3Config
  override readonly accessor: S3Accessor
  constructor(config: S3Config) {
    super()
    const normalized = normalizeKeyPrefix(config.keyPrefix)
    const cfg: S3Config = { ...config }
    if (normalized !== undefined) {
      cfg.keyPrefix = normalized
    } else {
      delete cfg.keyPrefix
    }
    this.config = cfg
    const proxy = cfg.proxy
    this.accessor = new S3Accessor({
      ...cfg,
      ...(proxy !== undefined && proxy !== ''
        ? { httpAgentProvider: () => createProxyAgents(proxy) }
        : {}),
    })
  }

  override storageLocation(): string {
    return s3StorageLocation(this.name, this.config)
  }
  override commands(): readonly RegisteredCommand[] {
    return S3_COMMANDS.toArray()
  }

  override ops(): readonly RegisteredOp[] {
    return S3_OPS
  }
  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override getState(): Promise<S3VFSState> {
    return Promise.resolve({
      type: this.name,
      config: redactConfig(this.config),
    })
  }

  override loadState(_state: S3VFSState): Promise<void> {
    return Promise.resolve()
  }
}
