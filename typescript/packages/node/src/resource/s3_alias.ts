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

import { S3Resource } from './s3/s3.ts'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { remapCommandsResource, remapOpsResource } from '@struktoai/mirage-core/resource/s3/remap'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/resource/secrets'
import { S3_FAMILY_NORMALIZER } from './s3/config.ts'
import type { S3Config, S3ConfigRedacted } from './s3/config.ts'

/**
 * Shared shape for the S3-compatible providers.
 *
 * Every alias is the same credentials plus one endpoint rule, so the
 * fields, the zod schema that drives redaction, the snake_case mapping and
 * the conversion to S3Config live here once. A provider declares only its
 * endpoint rule and whatever it genuinely adds. Mirrors Python's
 * `mirage/resource/s3_alias.py`.
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
  timeoutMs?: number
  proxy?: string
}

const ALIAS_SHAPE = {
  bucket: z.string(),
  accessKeyId: secretStr().optional(),
  secretAccessKey: secretStr().optional(),
  sessionToken: secretStr().optional(),
  profile: z.string().optional(),
  forcePathStyle: z.boolean().optional(),
  keyPrefix: z.string().optional(),
  timeoutMs: z.number().optional(),
  proxy: secretStr().optional(),
}

// What a caller may write, split the way python splits
// `RegionEndpointConfig` from `FixedEndpointConfig`: a regional provider
// must name its region and may override the endpoint; a self-hosted
// gateway must name its endpoint and may name a region.
const REGION_ALIAS_SCHEMA = z.object({
  ...ALIAS_SHAPE,
  region: z.string(),
  endpoint: z.string().optional(),
})

const FIXED_ALIAS_SCHEMA = z.object({
  ...ALIAS_SHAPE,
  region: z.string().optional(),
  endpoint: z.string(),
})

// The resolved shape, with the region and endpoint each provider's rule
// fills in, is what redaction and snapshot state see.
const ALIAS_SCHEMA = z.object({
  ...ALIAS_SHAPE,
  region: z.string(),
  endpoint: z.string(),
})

// Only the redacted twin derives: the schema is the resolved shape, with
// the region and endpoint each provider's rule fills in.
export type S3AliasConfigRedacted = RedactedConfig<
  ConfigOf<typeof ALIAS_SCHEMA>,
  'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'proxy'
>

export interface Alias<C extends S3AliasConfig, R> {
  toS3Config: (config: C) => S3Config
  redact: (config: C) => R
  normalize: (input: Record<string, unknown>) => C
}

const optional = (config: S3AliasConfig): Partial<S3Config> => ({
  ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
  ...(config.profile !== undefined ? { profile: config.profile } : {}),
  ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
  ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
})

/**
 * A provider whose endpoint is derived from its (required) region.
 *
 * `forcePathStyle` stays absent from the S3Config when the caller did not
 * ask for it, which is what the hand-written providers did and what the
 * S3 client treats as virtual-hosted style.
 */
export function makeRegionAlias<C extends S3AliasConfig & { region: string }, R>(
  endpointFor: (config: C) => string,
): Alias<C, R> & { resolvedEndpoint: (config: C) => string } {
  const resolvedEndpoint = (config: C): string =>
    config.endpoint !== undefined && config.endpoint !== '' ? config.endpoint : endpointFor(config)
  return {
    resolvedEndpoint,
    toS3Config: (config) => ({
      bucket: config.bucket,
      region: config.region,
      endpoint: resolvedEndpoint(config),
      ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
      ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
      ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      ...optional(config),
    }),
    redact: (config) =>
      redactConfigWithSchema(ALIAS_SCHEMA, {
        ...config,
        endpoint: resolvedEndpoint(config),
      }) as unknown as R,
    normalize: (input) =>
      parseConfigWithSchema(REGION_ALIAS_SCHEMA, input, S3_FAMILY_NORMALIZER) as unknown as C,
  }
}

/**
 * A self-hosted gateway reachable only at a caller-supplied endpoint.
 *
 * ceph, minio and seaweedfs have no public region to derive from, so the
 * region and path-style defaults are materialized rather than omitted.
 */
export function makeFixedAlias<C extends S3AliasConfig & { endpoint: string }, R>(): Alias<C, R> {
  const region = (config: C): string => config.region ?? 'us-east-1'
  const pathStyle = (config: C): boolean => config.forcePathStyle ?? true
  return {
    toS3Config: (config) => ({
      bucket: config.bucket,
      region: region(config),
      endpoint: config.endpoint,
      ...(config.accessKeyId !== undefined ? { accessKeyId: config.accessKeyId } : {}),
      ...(config.secretAccessKey !== undefined ? { secretAccessKey: config.secretAccessKey } : {}),
      forcePathStyle: pathStyle(config),
      ...optional(config),
    }),
    redact: (config) =>
      redactConfigWithSchema(ALIAS_SCHEMA, {
        ...config,
        region: region(config),
        forcePathStyle: pathStyle(config),
      }) as unknown as R,
    normalize: (input) =>
      parseConfigWithSchema(FIXED_ALIAS_SCHEMA, input, S3_FAMILY_NORMALIZER) as unknown as C,
  }
}

/**
 * The snapshot state of an S3-compatible alias: its own kind and its own
 * redacted config, not the `s3` kind and S3 config it delegates to.
 */
export interface S3AliasResourceState<TRedacted> {
  type: string
  config: TRedacted
}

/**
 * The shared body of every S3-compatible provider resource (MinIO, Ceph,
 * R2, Wasabi, ...). Each is an {@link S3Resource} reached through a
 * provider-shaped config, so all it owns is its `kind`, that config, and
 * ops/commands retagged from `s3` onto the kind. A subclass supplies its
 * prompt as a plain field and hands the varying pieces to `super`.
 *
 * `toS3Config` and `redact` arrive as functions rather than as an
 * {@link Alias}: the four providers whose region or endpoint rule fits
 * neither {@link makeRegionAlias} nor {@link makeFixedAlias} write their
 * own pair, so the resource layer takes the two functions every provider
 * has either way. Mirrors python `S3AliasResource` in
 * `mirage/resource/s3_alias.py`.
 */
export abstract class S3AliasResource<
  TConfig,
  TRedacted extends S3ConfigRedacted,
> extends S3Resource {
  override readonly kind: string
  readonly aliasConfig: TConfig
  private readonly aliasOps: readonly RegisteredOp[]
  private readonly aliasCommands: readonly RegisteredCommand[]
  private readonly redactAlias: (config: TConfig) => TRedacted

  protected constructor(
    kind: string,
    config: TConfig,
    s3Config: S3Config,
    redact: (config: TConfig) => TRedacted,
  ) {
    super(s3Config)
    this.kind = kind
    this.aliasConfig = config
    this.redactAlias = redact
    this.aliasOps = remapOpsResource(super.ops(), kind)
    this.aliasCommands = remapCommandsResource(super.commands(), kind)
  }

  override ops(): readonly RegisteredOp[] {
    return this.aliasOps
  }

  override commands(): readonly RegisteredCommand[] {
    return this.aliasCommands
  }

  override getState(): Promise<S3AliasResourceState<TRedacted>> {
    return Promise.resolve({
      type: this.kind,
      config: this.redactAlias(this.aliasConfig),
    })
  }

  override loadState(_state: S3AliasResourceState<TRedacted>): Promise<void> {
    return Promise.resolve()
  }
}
