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

import { S3Accessor } from '../../accessor/s3.ts'
import { VFSName } from '../../types.ts'
import { VFSConfigError } from '../errors.ts'
import type { S3Config as S3CoreConfig, S3HttpAgents } from '../s3/config.ts'
import {
  normalizeKeyPrefix,
  S3_FAMILY_RENAME,
  S3Config as S3CoreConfigSchema,
} from '../s3/config.ts'
import { S3VFS as CoreS3VFS, declaredEndpoint } from '../s3/s3.ts'
import { s3StorageLocation } from '../s3/storage_id.ts'
import type { RedactedSchema } from '../secrets.ts'
import { FIELD_NORMALIZERS, secretStr, z } from '../secrets.ts'
import type { ConfigState } from '../types.ts'

export interface S3Config extends S3CoreConfig {
  profile?: string
  proxy?: string
}

export const S3Config = S3CoreConfigSchema.extend({
  profile: z
    .string()
    .optional()
    .describe(
      'Named profile in the shared AWS config and credentials files that supplies credentials when no access key pair is given.',
    ),
  proxy: secretStr()
    .optional()
    .describe('Proxy URL for every HTTP and HTTPS request to the endpoint.'),
}).register(FIELD_NORMALIZERS, {
  rename: {
    aws_access_key_id: 'accessKeyId',
    aws_secret_access_key: 'secretAccessKey',
    aws_session_token: 'sessionToken',
    ...S3_FAMILY_RENAME,
  },
})

export class S3VFS extends CoreS3VFS {
  /**
   * The agents a mount's `proxy` sends its requests through, which a host
   * with sockets of its own sets (node); without it, a mount that names a
   * proxy is refused.
   */
  static proxyAgents: ((proxy: string) => S3HttpAgents) | null = null

  override readonly name: string = VFSName.S3
  override readonly cachesReads: boolean = true
  override readonly supportsSnapshot: boolean = true
  override readonly sizesAlwaysKnown: boolean = true
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
    const agents = S3VFS.proxyAgents
    if (proxy !== undefined && proxy !== '' && agents === null) {
      throw new VFSConfigError('s3: this host cannot send requests through a proxy; drop proxy')
    }
    this.accessor = new S3Accessor({
      ...cfg,
      ...(this.declared !== undefined ? { endpoint: this.declared } : {}),
      ...(proxy !== undefined && proxy !== '' && agents !== null
        ? { httpAgentProvider: () => agents(proxy) }
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
