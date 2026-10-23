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

import { z } from 'zod'
import {
  type ConfigOf,
  redactConfigWithSchema,
  type RedactedConfig,
  secretSchema,
  secretStr,
} from '../secrets.ts'
import * as kp from '../../utils/key_prefix.ts'

export type S3BrowserOperation = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'LIST' | 'COPY'

export interface S3BrowserSignOptions {
  contentType?: string
  ttlSec?: number
  listPrefix?: string
  listDelimiter?: string
  listContinuationToken?: string
  copySource?: string
}

export type S3BrowserPresignedUrlProvider = (
  path: string,
  operation: S3BrowserOperation,
  options?: S3BrowserSignOptions,
) => Promise<string>

export interface S3HttpAgents {
  httpAgent: unknown
  httpsAgent: unknown
}

/**
 * Runtime-supplied transport agents (Node proxy support). Called once per
 * client so each client owns its own agents: every S3 op destroys its client
 * when it finishes, and a shared agent pair would tear down sockets that
 * concurrent ops are still using.
 */
export type S3HttpAgentProvider = () => S3HttpAgents

export const S3ConfigSchema = z.object({
  bucket: z.string().describe('Name of the bucket to mount.'),
  region: z
    .string()
    .optional()
    .describe(
      "AWS region requests are signed for and sent to. Unset leaves it to the AWS SDK's environment variables and profile.",
    ),
  endpoint: z
    .string()
    .optional()
    .describe(
      "Endpoint URL of an S3-compatible server. Unset, the node mount uses `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` when set, else AWS's endpoint for `region`; an endpoint set only in an AWS profile is not read.",
    ),
  accessKeyId: secretStr()
    .optional()
    .describe(
      'Access key ID, used only together with `secretAccessKey`. Unset falls back to the AWS SDK credential chain: `profile`, the environment, the shared credentials file, then an instance role.',
    ),
  secretAccessKey: secretStr().optional().describe('Secret access key paired with `accessKeyId`.'),
  sessionToken: secretStr()
    .optional()
    .describe('Session token for temporary credentials, sent with the access key pair.'),
  forcePathStyle: z
    .boolean()
    .optional()
    .describe(
      'Address the bucket in the URL path (`<endpoint>/<bucket>/<key>`) instead of as a subdomain of the endpoint.',
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe(
      "Milliseconds to wait to connect, and for each read of a response, before the request fails. Unset leaves the AWS SDK's own timeouts. Applies to the AWS SDK client only: with `presignedUrlProvider` the signed-URL requests take no timeout.",
    ),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  )
    .optional()
    .describe(
      'Function `(path, operation, options)` that returns a signed URL for one S3 operation (`GET`, `PUT`, `HEAD`, `DELETE`, `LIST` or `COPY`). When set, the mount fetches those URLs instead of signing requests itself, so it needs no credentials.',
    ),
  httpAgentProvider: secretSchema(
    z.custom<S3HttpAgentProvider>((value) => typeof value === 'function'),
  )
    .optional()
    .describe(
      'Function that returns the `httpAgent` and `httpsAgent` for one S3 client, called once per client. The node mount builds it from `proxy` when that is set.',
    ),
  defaultContentType: z
    .string()
    .optional()
    .describe(
      '`Content-Type` stored with every object the mount writes. Unset sends none, so the store applies its own default; a write through `presignedUrlProvider` sends `application/octet-stream`.',
    ),
  keyPrefix: z
    .string()
    .optional()
    .describe(
      'Key prefix inside the bucket that the mount treats as its root; keys outside it are not visible. Leading slashes are dropped and a trailing `/` is added.',
    ),
})

export interface S3Config {
  bucket: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  forcePathStyle?: boolean
  timeoutMs?: number
  presignedUrlProvider?: S3BrowserPresignedUrlProvider
  httpAgentProvider?: S3HttpAgentProvider
  defaultContentType?: string
  keyPrefix?: string
}

export function normalizeKeyPrefix(v: string | undefined): string | undefined {
  const out = kp.normalize(v)
  return out === '' ? undefined : out
}

// Only the redacted twin derives: `S3Config` carries a `profile` the schema
// does not, so the schema is not this config's own shape.
export type S3ConfigRedacted = RedactedConfig<
  ConfigOf<typeof S3ConfigSchema>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'presignedUrlProvider' | 'httpAgentProvider'
>

export function redactConfig(config: S3Config): S3ConfigRedacted {
  return redactConfigWithSchema(S3ConfigSchema, config) as unknown as S3ConfigRedacted
}
