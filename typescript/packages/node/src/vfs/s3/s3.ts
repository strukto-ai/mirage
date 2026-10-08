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

import { S3VFSBase } from '@struktoai/mirage-core/vfs/s3/s3'
import { S3Accessor } from '@struktoai/mirage-core/accessor/s3'

import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import type { S3HttpAgents } from '@struktoai/mirage-core/vfs/s3/config'
import { PROMPT } from '@struktoai/mirage-core/vfs/s3/prompt'
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

/**
 * The endpoint a mount declares, for its write-condition row: the config's,
 * else AWS_ENDPOINT_URL_S3 or AWS_ENDPOINT_URL unless
 * AWS_IGNORE_CONFIGURED_ENDPOINT_URLS is true. An endpoint set only in an AWS
 * profile is not read.
 */
function declaredEndpoint(config: S3Config): string | undefined {
  if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
  const env = process.env
  if (env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS?.toLowerCase() === 'true') return undefined
  const endpoint = env.AWS_ENDPOINT_URL_S3 ?? ''
  if (endpoint !== '') return endpoint
  return env.AWS_ENDPOINT_URL !== '' ? env.AWS_ENDPOINT_URL : undefined
}

export class S3VFS extends S3VFSBase {
  override readonly name: string = VFSName.S3
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp the ETag, so the gate compares like with
  // like. Inherited by every S3AliasVFS provider.
  override readonly readRevalidatable: boolean = true
  override readonly prompt: string = PROMPT
  readonly config: S3Config
  override readonly accessor: S3Accessor

  /**
   * The endpoint this mount declared when it was built, fixed then so the
   * load-time verdict and every later write judge the same endpoint.
   * Mirrors python's `resolved_endpoint`.
   */
  readonly resolvedEndpoint: string | undefined

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
    this.resolvedEndpoint = declaredEndpoint(cfg)
    const proxy = cfg.proxy
    this.accessor = new S3Accessor({
      ...cfg,
      ...(proxy !== undefined && proxy !== ''
        ? { httpAgentProvider: () => createProxyAgents(proxy) }
        : {}),
    })
  }

  override storageLocation(): string {
    return s3StorageLocation(this.config)
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
}
