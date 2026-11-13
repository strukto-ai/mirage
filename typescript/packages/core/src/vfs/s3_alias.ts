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

import { timeoutShape } from '../core/api/config.ts'
import type { ConfigOf, RedactedSchema } from './secrets.ts'
import { FIELD_NORMALIZERS, redactedConfigDump, secretStr, z } from './secrets.ts'
import type { ConfigState } from './types.ts'
import type { S3Config } from './direct/s3.ts'
import { S3_FAMILY_RENAME } from './s3/config.ts'
import { S3VFS } from './direct/s3.ts'

/**
 * Shared shape for the S3-compatible providers.
 *
 * Every alias is the same credentials plus one endpoint rule, so the
 * fields, the zod schema that drives redaction, the snake_case mapping and
 * the conversion to S3Config live here once. A provider declares only its
 * endpoint rule and whatever it genuinely adds. Mirrors Python's
 * `mirage/vfs/s3_alias.py`.
 *
 * Only `bucket` and whatever the endpoint genuinely needs are required.
 * Credentials are optional because `S3Config` leaves them optional too, so
 * omitting them falls through to the usual AWS resolution order: `profile`,
 * then the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` environment
 * variables, then the shared credentials file, then an instance role.
 * `sessionToken` and `profile` live here rather than on the one provider
 * that first needed them, so every alias accepts them.
 */
export interface S3AliasConfig {
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
  keyPrefix?: string
  timeout?: number
  proxy?: string
}

export const ALIAS_SHAPE = {
  bucket: z.string().describe('Name of the bucket to mount.'),
  accessKeyId: secretStr()
    .optional()
    .describe(
      'Access key ID; set it with `secretAccessKey`. Unset uses the AWS SDK credential chain.',
    ),
  secretAccessKey: secretStr().optional().describe('Secret access key paired with `accessKeyId`.'),
  sessionToken: secretStr()
    .optional()
    .describe('Session token for temporary credentials, sent with the access key pair.'),
  profile: z
    .string()
    .optional()
    .describe(
      'Named profile in the shared AWS config and credentials files that supplies credentials when no access key pair is given.',
    ),
  forcePathStyle: z
    .boolean()
    .optional()
    .describe(
      'Address the bucket in the URL path (`<endpoint>/<bucket>/<key>`) instead of as a subdomain of the endpoint.',
    ),
  keyPrefix: z
    .string()
    .optional()
    .describe(
      'Key prefix inside the bucket that the mount treats as its root; keys outside it are not visible. Leading slashes are dropped and a trailing `/` is added.',
    ),
  ...timeoutShape,
  proxy: secretStr()
    .optional()
    .describe('Proxy URL for every HTTP and HTTPS request to the endpoint.'),
}

/**
 * The shared fields plus whatever one provider's endpoint rule needs, under
 * the S3 family's python spellings. The browser's twin has the same name.
 */
export function aliasSchema<E extends z.ZodRawShape>(
  extra: E,
): z.ZodObject<typeof ALIAS_SHAPE & E> {
  return z
    .object({ ...ALIAS_SHAPE, ...extra })
    .register(FIELD_NORMALIZERS, { rename: S3_FAMILY_RENAME })
}

// What a caller may write, split as python splits its two models: a
// regional provider must name its region and may override the endpoint; a
// self-hosted gateway must name its endpoint and may name a region.
export const RegionEndpointConfig = aliasSchema({
  region: z
    .string()
    .describe(
      'Provider region every request is signed for. Most providers also build their endpoint URL from it unless `endpoint` is set.',
    ),
  endpoint: z
    .string()
    .optional()
    .describe('Endpoint URL that replaces the one the provider derives.'),
})

export const FixedEndpointConfig = aliasSchema({
  forcePathStyle: z.boolean().optional().meta({ default: true }),
  region: z.string().optional().meta({
    description: "Region requests are signed for; the gateway's endpoint does not depend on it.",
    default: 'us-east-1',
  }),
  endpoint: z
    .string()
    .describe('URL of the self-hosted S3 gateway, such as `http://localhost:9000`.'),
})

export interface Alias<C extends S3AliasConfig, R> {
  resolvedEndpoint: (config: C) => string
  toS3Config: (config: C) => S3Config
  redact: (config: C) => R
}

/**
 * Build one provider's config helpers from its endpoint rule.
 *
 * `endpointFor` is consulted only when the caller gave no explicit
 * endpoint. `regionDefault` materializes a region the provider always has
 * (gcs and r2 report `auto`, wasabi and the self-hosted gateways
 * `us-east-1`), and `forcePathStyle` the path style it defaults to (oci,
 * supabase and the gateways). Without one, `forcePathStyle` stays absent
 * from the S3Config unless the caller asked for it, which the S3 client
 * treats as virtual-hosted style. The redacted config carries the same
 * resolved values the S3Config does.
 */
export function makeS3Alias<S extends z.ZodObject>(options: {
  schema: S
  endpointFor: (config: ConfigOf<S> & S3AliasConfig) => string
  regionDefault?: string
  forcePathStyle?: boolean
}): S & Alias<ConfigOf<S> & S3AliasConfig, RedactedSchema<S>> {
  const { schema, endpointFor, regionDefault, forcePathStyle } = options
  const resolvedEndpoint = (config: ConfigOf<S> & S3AliasConfig): string =>
    config.endpoint !== undefined && config.endpoint !== '' ? config.endpoint : endpointFor(config)
  const resolved = (
    config: ConfigOf<S> & S3AliasConfig,
  ): Pick<S3Config, 'endpoint' | 'region' | 'forcePathStyle'> => {
    const region = config.region ?? regionDefault
    const pathStyle = config.forcePathStyle ?? forcePathStyle
    return {
      endpoint: resolvedEndpoint(config),
      ...(region !== undefined ? { region } : {}),
      ...(pathStyle !== undefined ? { forcePathStyle: pathStyle } : {}),
    }
  }
  const alias: Alias<ConfigOf<S> & S3AliasConfig, RedactedSchema<S>> = {
    resolvedEndpoint,
    toS3Config: (config) => ({
      bucket: config.bucket,
      ...resolved(config),
      ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
      ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
      ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
      ...(config.profile !== undefined ? { profile: config.profile } : {}),
      ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
      ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
    }),
    redact: (config) => redactedConfigDump(schema, { ...config, ...resolved(config) }),
  }
  return Object.assign(schema.clone(), alias)
}

/**
 * The shared body of every S3-compatible provider VFS (MinIO, Ceph,
 * R2, Wasabi, ...). Each is an {@link S3VFS} reached through a
 * provider-shaped config, so all it owns is its `name`, that config and the
 * {@link Alias} that converts and redacts it; the mount serves S3's
 * commands under the name. A subclass supplies its prompt as a plain field
 * and hands the varying pieces to `super`. Mirrors python `S3AliasVFS` in
 * `mirage/vfs/s3_alias.py`.
 */
export abstract class S3AliasVFS<
  TConfig extends S3AliasConfig,
  TRedacted extends RedactedSchema<typeof S3Config>,
> extends S3VFS {
  override readonly name: string
  readonly aliasConfig: TConfig
  private readonly alias: Alias<TConfig, TRedacted>

  protected constructor(name: string, config: TConfig, alias: Alias<TConfig, TRedacted>) {
    super(alias.toS3Config(config))
    this.name = name
    this.aliasConfig = config
    this.alias = alias
  }

  override getState(): Promise<ConfigState<TRedacted>> {
    return Promise.resolve({
      type: this.name,
      config: this.alias.redact(this.aliasConfig),
    })
  }
}
