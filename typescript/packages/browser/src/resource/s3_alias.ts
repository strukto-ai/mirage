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
  secretSchema,
  z,
} from '@struktoai/mirage-core/resource/secrets'
import { S3_BROWSER_RENAME } from './s3/config.ts'
import type { S3BrowserPresignedUrlProvider, S3Config, S3ConfigRedacted } from './s3/config.ts'

/**
 * Shared shape for the browser's S3-compatible providers.
 *
 * Every alias is the same presigned-fetch config plus one endpoint rule,
 * so the fields, the zod schema that drives redaction, and the conversion
 * to S3Config live here once. A provider declares only its endpoint rule
 * and whatever it genuinely adds. The node twin is
 * `packages/node/src/resource/s3_alias.ts`; it carries credentials and a
 * snake_case `normalize` where this one carries a
 * `presignedUrlProvider`, which is one field's difference and not a
 * reason to fork the family.
 *
 * Only `bucket` and the provider are required. `region` and `endpoint`
 * are optional here — unlike node, where a regional provider must have a
 * region — because a presigned URL already names its host, so an alias
 * that can derive neither simply leaves both off the S3Config.
 */
export interface S3BrowserAliasConfig {
  bucket: string
  presignedUrlProvider: S3BrowserPresignedUrlProvider
  region?: string
  endpoint?: string
  defaultContentType?: string
  keyPrefix?: string
}

export const BROWSER_ALIAS_FIELDS = {
  bucket: z.string(),
  presignedUrlProvider: secretSchema(
    z.custom<S3BrowserPresignedUrlProvider>((value) => typeof value === 'function'),
  ),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  defaultContentType: z.string().optional(),
  keyPrefix: z.string().optional(),
}

/**
 * The shared schema, plus whatever one provider's endpoint rule needs
 * (r2's `accountId`, oci's `namespace`, supabase's `projectRef`).
 *
 * The extra fields land after the shared ones rather than where each
 * hand-written schema happened to put them. That is only visible in the
 * key order of a redacted config, which nothing pins.
 */
export function browserAliasSchema<E extends z.ZodRawShape>(
  extra: E,
): z.ZodObject<typeof BROWSER_ALIAS_FIELDS & E> {
  return z.object({ ...BROWSER_ALIAS_FIELDS, ...extra })
}

/**
 * The common endpoint rule: one config field fills one URL template.
 *
 * Most providers key off `region`; r2 keys off `accountId` and supabase
 * off `projectRef`. An absent or empty field yields no endpoint rather
 * than a URL with a hole in it. oci needs two fields, and gcs and wasabi
 * always resolve, so those three pass their own `endpointFor`.
 */
export function derivedEndpoint<C extends S3BrowserAliasConfig>(
  key: keyof C & string,
  template: (value: string) => string,
): (config: C) => string | undefined {
  return (config) => {
    const value = config[key]
    return typeof value === 'string' && value !== '' ? template(value) : undefined
  }
}

export interface BrowserAlias<C, R, E extends string | undefined> {
  resolvedEndpoint: (config: C) => string | E
  toS3Config: (config: C) => S3Config
  redact: (config: C) => R
  normalize: (input: Record<string, unknown>) => C
}

/**
 * Build one provider's config helpers from its endpoint rule.
 *
 * `endpointFor` is consulted only when the caller gave no explicit
 * endpoint, and may answer `undefined` when the config lacks whatever
 * the rule needs (a region, an account id); the S3Config then carries no
 * endpoint at all. `regionDefault` materializes a region the provider
 * always has (gcs and r2 report `auto`), and `forcePathStyle` is set
 * only by supabase, whose gateway does not serve virtual-hosted style.
 */
export function makeBrowserS3Alias<
  C extends S3BrowserAliasConfig,
  R,
  E extends string | undefined = string | undefined,
>(options: {
  schema: z.ZodObject<z.ZodRawShape>
  endpointFor?: (config: C) => E
  regionDefault?: string
  forcePathStyle?: boolean
}): BrowserAlias<C, R, E> {
  const { schema, endpointFor, regionDefault, forcePathStyle } = options
  const resolvedEndpoint = (config: C): string | E => {
    if (config.endpoint !== undefined && config.endpoint !== '') return config.endpoint
    return endpointFor === undefined ? (undefined as E) : endpointFor(config)
  }
  return {
    resolvedEndpoint,
    toS3Config: (config) => {
      const endpoint = resolvedEndpoint(config)
      const region = config.region ?? regionDefault
      return {
        bucket: config.bucket,
        presignedUrlProvider: config.presignedUrlProvider,
        ...(region !== undefined ? { region } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
        ...(config.defaultContentType !== undefined
          ? { defaultContentType: config.defaultContentType }
          : {}),
        ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
      }
    },
    redact: (config) => redactConfigWithSchema(schema, config) as unknown as R,
    normalize: (input) =>
      parseConfigWithSchema(schema, input, { rename: S3_BROWSER_RENAME }) as unknown as C,
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
