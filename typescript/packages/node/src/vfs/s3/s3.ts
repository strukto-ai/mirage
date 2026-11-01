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
import { VFSName } from '@struktoai/mirage-core/types'
import type { S3HttpAgents } from '@struktoai/mirage-core/vfs/s3/config'
import { normalizeKeyPrefix } from '@struktoai/mirage-core/vfs/s3/config'
import { S3VFS as CoreS3VFS } from '@struktoai/mirage-core/vfs/s3/s3'
import { s3StorageLocation } from '@struktoai/mirage-core/vfs/s3/storage_id'
import type { RedactedSchema } from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigState } from '@struktoai/mirage-core/vfs/types'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { S3Config } from './config.ts'

function createProxyAgents(proxy: string): S3HttpAgents {
  return { httpAgent: new HttpProxyAgent(proxy), httpsAgent: new HttpsProxyAgent(proxy) }
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

export class S3VFS extends CoreS3VFS {
  override readonly name: string = VFSName.S3
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  // stat and read both stamp the ETag, so the gate compares like with
  // like. Inherited by every S3AliasVFS provider.
  override readonly readRevalidatable: boolean = true
  readonly config: S3Config
  override readonly accessor: S3Accessor

  private readonly declared: string | undefined

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
    this.declared = declaredEndpoint(cfg)
    const proxy = cfg.proxy
    this.accessor = new S3Accessor({
      ...cfg,
      ...(this.declared !== undefined ? { endpoint: this.declared } : {}),
      ...(proxy !== undefined && proxy !== ''
        ? { httpAgentProvider: () => createProxyAgents(proxy) }
        : {}),
    })
  }

  /**
   * The endpoint this mount's writes go to. One declared when the mount was
   * built is fixed, and the client is pinned to it; without one, the
   * environment is read again, as each op's client reads it. Mirrors
   * Python's `resolved_endpoint`.
   */
  override get resolvedEndpoint(): string | undefined {
    return this.declared ?? declaredEndpoint(this.config)
  }

  override storageLocation(): string {
    return s3StorageLocation(this.config)
  }

  override getState(): Promise<ConfigState<RedactedSchema<typeof S3Config>>> {
    return Promise.resolve(this.configState(S3Config, this.config))
  }
}
