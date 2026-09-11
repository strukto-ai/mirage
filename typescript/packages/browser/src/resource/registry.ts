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

import { resolveConfigSecrets } from '@struktoai/mirage-core/secrets/sources'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import type { Resource } from '@struktoai/mirage-core/resource/base'
import { z } from '@struktoai/mirage-core/resource/secrets'
import { errorSummary } from '@struktoai/mirage-core/secrets/summary'
import type { RedisResourceOptions } from './redis/redis.ts'
import { normalizeFields } from '@struktoai/mirage-core/utils/normalize'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { recordResourceRef } from '@struktoai/mirage-core/resource/base'

/**
 * Construct a resource by registry name in the browser runtime.
 * Mirrors Python's `mirage.resource.registry.build_resource` and the
 * Node TS counterpart at `@struktoai/mirage-node/resource/registry`.
 *
 * Configs are normalized from Python-style snake_case to TS camelCase so
 * the same YAML schema works across both runtimes.
 *
 * The S3 entry expects a browser-shaped config — bucket + a
 * `presignedUrlProvider` function. Since functions can't be encoded
 * in JSON/YAML, browser configs are typically constructed
 * programmatically and passed in directly.
 */
export type ResourceFactory = (config: Record<string, unknown>) => Promise<Resource>

const REGISTRY: Record<string, ResourceFactory> = {
  ram: async (_config) => {
    const { RAMResource } = await import('@struktoai/mirage-core/resource/ram/ram')
    return new RAMResource()
  },
  opfs: async (config) => {
    const { OPFSResource } = await import('./opfs/opfs.ts')
    const norm = normalizeFields(config)
    return new OPFSResource(norm)
  },
  s3: async (config) => {
    const { S3Resource } = await import('./s3/s3.ts')
    const { normalizeS3Config } = await import('./s3/config.ts')
    return new S3Resource(normalizeS3Config(config))
  },
  gcs: async (config) => {
    const { GCSResource } = await import('./gcs/gcs.ts')
    const { normalizeGCSConfig } = await import('./gcs/config.ts')
    return new GCSResource(normalizeGCSConfig(config))
  },
  r2: async (config) => {
    const { R2Resource } = await import('./r2/r2.ts')
    const { normalizeR2Config } = await import('./r2/config.ts')
    return new R2Resource(normalizeR2Config(config))
  },
  oci: async (config) => {
    const { OCIResource } = await import('./oci/oci.ts')
    const { normalizeOCIConfig } = await import('./oci/config.ts')
    return new OCIResource(normalizeOCIConfig(config))
  },
  supabase: async (config) => {
    const { SupabaseResource } = await import('./supabase/supabase.ts')
    const { normalizeSupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseResource(normalizeSupabaseConfig(config))
  },
  minio: async (config) => {
    const { MinIOResource } = await import('./minio/minio.ts')
    const { normalizeMinIOConfig } = await import('./minio/config.ts')
    return new MinIOResource(normalizeMinIOConfig(config))
  },
  ceph: async (config) => {
    const { CephResource } = await import('./ceph/ceph.ts')
    const { normalizeCephConfig } = await import('./ceph/config.ts')
    return new CephResource(normalizeCephConfig(config))
  },
  seaweedfs: async (config) => {
    const { SeaweedFSResource } = await import('./seaweedfs/seaweedfs.ts')
    const { normalizeSeaweedFSConfig } = await import('./seaweedfs/config.ts')
    return new SeaweedFSResource(normalizeSeaweedFSConfig(config))
  },
  wasabi: async (config) => {
    const { WasabiResource } = await import('./wasabi/wasabi.ts')
    const { normalizeWasabiConfig } = await import('./wasabi/config.ts')
    return new WasabiResource(normalizeWasabiConfig(config))
  },
  backblaze: async (config) => {
    const { BackblazeResource } = await import('./backblaze/backblaze.ts')
    const { normalizeBackblazeConfig } = await import('./backblaze/config.ts')
    return new BackblazeResource(normalizeBackblazeConfig(config))
  },
  digitalocean: async (config) => {
    const { DigitalOceanResource } = await import('./digitalocean/digitalocean.ts')
    const { normalizeDigitalOceanConfig } = await import('./digitalocean/config.ts')
    return new DigitalOceanResource(normalizeDigitalOceanConfig(config))
  },
  tencent: async (config) => {
    const { TencentResource } = await import('./tencent/tencent.ts')
    const { normalizeTencentConfig } = await import('./tencent/config.ts')
    return new TencentResource(normalizeTencentConfig(config))
  },
  aliyun: async (config) => {
    const { AliyunResource } = await import('./aliyun/aliyun.ts')
    const { normalizeAliyunConfig } = await import('./aliyun/config.ts')
    return new AliyunResource(normalizeAliyunConfig(config))
  },
  scaleway: async (config) => {
    const { ScalewayResource } = await import('./scaleway/scaleway.ts')
    const { normalizeScalewayConfig } = await import('./scaleway/config.ts')
    return new ScalewayResource(normalizeScalewayConfig(config))
  },
  qingstor: async (config) => {
    const { QingStorResource } = await import('./qingstor/qingstor.ts')
    const { normalizeQingStorConfig } = await import('./qingstor/config.ts')
    return new QingStorResource(normalizeQingStorConfig(config))
  },
  slack: async (config) => {
    const { SlackResource } = await import('./slack/slack.ts')
    const { normalizeSlackConfig } = await import('./slack/config.ts')
    return new SlackResource(normalizeSlackConfig(config))
  },
  discord: async (config) => {
    const { DiscordResource } = await import('./discord/discord.ts')
    const { normalizeDiscordConfig } = await import('./discord/config.ts')
    return new DiscordResource(normalizeDiscordConfig(config))
  },
  trello: async (config) => {
    const { TrelloResource } = await import('./trello/trello.ts')
    const { normalizeTrelloConfig } = await import('./trello/config.ts')
    return new TrelloResource(normalizeTrelloConfig(config))
  },
  linear: async (config) => {
    const { LinearResource } = await import('./linear/linear.ts')
    const { normalizeLinearConfig } = await import('@struktoai/mirage-core/core/linear/config')
    return new LinearResource(normalizeLinearConfig(config))
  },
  postgres: async (config) => {
    const { PostgresResource } = await import('./postgres/postgres.ts')
    const { normalizePostgresConfig } =
      await import('@struktoai/mirage-core/resource/postgres/config')
    return new PostgresResource(normalizePostgresConfig(config))
  },
  mongodb: async (config) => {
    const { MongoDBResource } = await import('./mongodb/mongodb.ts')
    const { normalizeMongoDBConfig } =
      await import('@struktoai/mirage-core/resource/mongodb/config')
    return new MongoDBResource(normalizeMongoDBConfig(config))
  },
  chroma: async (config) => {
    const { ChromaResource } = await import('@struktoai/mirage-core/resource/chroma/chroma')
    const { normalizeChromaConfig } = await import('@struktoai/mirage-core/resource/chroma/config')
    return new ChromaResource(normalizeChromaConfig(config))
  },
  dify: async (config) => {
    const { DifyResource } = await import('@struktoai/mirage-core/resource/dify/dify')
    const { normalizeDifyConfig } = await import('@struktoai/mirage-core/resource/dify/config')
    return new DifyResource(normalizeDifyConfig(config))
  },
  qdrant: async (config) => {
    const { QdrantResource } = await import('@struktoai/mirage-core/resource/qdrant/qdrant')
    const { normalizeQdrantConfig } = await import('@struktoai/mirage-core/resource/qdrant/config')
    return new QdrantResource(normalizeQdrantConfig(config))
  },
  redis: async (config) => {
    const { RedisResource } = await import('./redis/redis.ts')
    return new RedisResource(normalizeFields(config) as unknown as RedisResourceOptions)
  },
  lancedb: (_config) => {
    return Promise.reject(
      new Error(
        'LanceDBResource is not supported in the browser: @lancedb/lancedb is a native ' +
          'Node addon. Use @struktoai/mirage-node from a server.',
      ),
    )
  },
  notion: async (config) => {
    const { NotionResource } = await import('./notion/notion.ts')
    const { normalizeNotionConfig } = await import('./notion/config.ts')
    return new NotionResource(normalizeNotionConfig(config))
  },
  langfuse: async (config) => {
    const { LangfuseResource } = await import('./langfuse/langfuse.ts')
    const { normalizeLangfuseConfig } = await import('./langfuse/config.ts')
    return new LangfuseResource(normalizeLangfuseConfig(config))
  },
  github: async (config) => {
    const { GitHubResource } = await import('./github/github.ts')
    const { normalizeGitHubConfig } = await import('@struktoai/mirage-core/core/github/config')
    return GitHubResource.create(normalizeGitHubConfig(config))
  },
  gcal: async (config) => {
    const { GCalResource } = await import('./gcal/gcal.ts')
    const { normalizeGCalConfig } = await import('@struktoai/mirage-core/resource/gcal/config')
    return new GCalResource(normalizeGCalConfig(config))
  },
  gdocs: async (config) => {
    const { GDocsResource } = await import('./gdocs/gdocs.ts')
    const { normalizeGDocsConfig } = await import('@struktoai/mirage-core/resource/gdocs/config')
    return new GDocsResource(normalizeGDocsConfig(config))
  },
  gsheets: async (config) => {
    const { GSheetsResource } = await import('./gsheets/gsheets.ts')
    const { normalizeGSheetsConfig } =
      await import('@struktoai/mirage-core/resource/gsheets/config')
    return new GSheetsResource(normalizeGSheetsConfig(config))
  },
  gslides: async (config) => {
    const { GSlidesResource } = await import('./gslides/gslides.ts')
    const { normalizeGSlidesConfig } =
      await import('@struktoai/mirage-core/resource/gslides/config')
    return new GSlidesResource(normalizeGSlidesConfig(config))
  },
  gdrive: async (config) => {
    const { GDriveResource } = await import('./gdrive/gdrive.ts')
    const { normalizeGDriveConfig } = await import('@struktoai/mirage-core/resource/gdrive/config')
    return new GDriveResource(normalizeGDriveConfig(config))
  },
  onedrive: async (config) => {
    const { normalizeOneDriveConfig } = await import('@struktoai/mirage-core/accessor/onedrive')
    const { OneDriveResource } = await import('@struktoai/mirage-core/resource/onedrive/onedrive')
    return new OneDriveResource(normalizeOneDriveConfig(config))
  },
  sharepoint: async (config) => {
    const { normalizeSharePointConfig } = await import('@struktoai/mirage-core/accessor/sharepoint')
    const { SharePointResource } =
      await import('@struktoai/mirage-core/resource/sharepoint/sharepoint')
    return new SharePointResource(normalizeSharePointConfig(config))
  },
  mem0: async (config) => {
    const { normalizeMem0Config } = await import('@struktoai/mirage-core/resource/mem0/config')
    const { Mem0Resource } = await import('@struktoai/mirage-core/resource/mem0/mem0')
    return new Mem0Resource(normalizeMem0Config(config))
  },
  dropbox: async (config) => {
    const { DropboxResource } = await import('./dropbox/dropbox.ts')
    const { normalizeDropboxConfig } = await import('./dropbox/config.ts')
    return new DropboxResource(normalizeDropboxConfig(config))
  },
  box: async (config) => {
    const { BoxResource } = await import('./box/box.ts')
    const { normalizeBoxConfig } = await import('./box/config.ts')
    return new BoxResource(normalizeBoxConfig(config))
  },
  gmail: async (config) => {
    const { GmailResource } = await import('./gmail/gmail.ts')
    const { normalizeGmailConfig } = await import('@struktoai/mirage-core/resource/gmail/config')
    return new GmailResource(normalizeGmailConfig(config))
  },
  email: (_config) => {
    return Promise.reject(
      new Error(
        'EmailResource is not supported in the browser: IMAP/SMTP require raw TCP. ' +
          'Use @struktoai/mirage-node from a server, or proxy IMAP/SMTP via a backend.',
      ),
    )
  },
}

const CUSTOM: Record<string, ResourceFactory> = {}

export function knownResources(): string[] {
  return [...new Set([...Object.keys(REGISTRY), ...Object.keys(CUSTOM)])].sort(compareCodePoints)
}

/**
 * Register a custom resource factory under `name`. Builtin names cannot
 * be shadowed; re-registering a custom name replaces it. Mirrors
 * Python's `register_resource` and the Node counterpart.
 */
export function register(name: string, factory: ResourceFactory): void {
  if (name in REGISTRY) throw new Error(`cannot register '${name}': shadows a builtin`)
  CUSTOM[name] = factory
}

export async function buildResource(
  name: string,
  config: Record<string, unknown> = {},
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<Resource> {
  // A `{from, ref, key}` in the config is fetched here, before the
  // resource's own schema parses, so every credential reaches its
  // client as the plain string it already reads. Python resolves one
  // step earlier, in its config door, because `build_resource` is sync
  // by rule there. A config with no pointer does no I/O.
  const resolved = await resolveConfigSecrets(config, sources, `mounts.${name}.config`)
  const factory = REGISTRY[name] ?? CUSTOM[name]
  if (factory === undefined) {
    throw new Error(
      `unknown resource ${JSON.stringify(name)}; known: ${knownResources().join(', ')}`,
    )
  }
  let built: Resource
  try {
    built = await factory(resolved)
  } catch (err) {
    // A mount config is where a fetched credential lands, and the create
    // route answers this message as its 400 detail: zod's own rendering
    // would hand the refused value straight back. Field and code only, the
    // way python's `build_resource` reports its config class.
    if (err instanceof z.ZodError) throw new Error(`${name}: ${errorSummary(err)}`)
    throw err
  }
  recordResourceRef(built, name)
  return built
}
