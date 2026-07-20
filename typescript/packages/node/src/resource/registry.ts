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

import { normalizeFields, type Resource } from '@struktoai/mirage-core'

/**
 * Construct a resource by registry name. Mirrors Python's
 * `mirage.resource.registry.build_resource`.
 *
 * Each entry is an async factory that lazy-imports its module so that
 * importing this file doesn't pull in every backend's dependencies.
 * Only the resource you actually request gets loaded — important for
 * S3/Redis whose peer deps (`@aws-sdk/client-s3`, `redis`) are optional.
 *
 * Configs are normalized from Python-style snake_case (used in YAML and
 * by the Python `mirage.config` loader) to TS-idiomatic camelCase. So
 * the same YAML file works in both Python and TS.
 */
export type ResourceFactory = (config: Record<string, unknown>) => Promise<Resource>

const REGISTRY: Record<string, ResourceFactory> = {
  ram: async (_config) => {
    const { RAMResource } = await import('@struktoai/mirage-core')
    return new RAMResource()
  },
  disk: async (config) => {
    const { DiskResource } = await import('./disk/disk.ts')
    const norm = normalizeFields(config) as { root: string }
    return new DiskResource(norm)
  },
  redis: async (config) => {
    const { RedisResource } = await import('./redis/redis.ts')
    const norm = normalizeFields(config)
    return new RedisResource(norm)
  },
  s3: async (config) => {
    const { S3Resource } = await import('./s3/s3.ts')
    const { normalizeS3Config } = await import('./s3/config.ts')
    return new S3Resource(normalizeS3Config(config))
  },
  gridfs: async (config) => {
    const { GridFSResource } = await import('./gridfs/gridfs.ts')
    const { normalizeGridFSConfig } = await import('./gridfs/config.ts')
    return new GridFSResource(normalizeGridFSConfig(config))
  },
  gcs: async (config) => {
    const { GCSResource } = await import('./gcs/gcs.ts')
    const { normalizeGcsConfig } = await import('./gcs/config.ts')
    return new GCSResource(normalizeGcsConfig(config))
  },
  oci: async (config) => {
    const { OCIResource } = await import('./oci/oci.ts')
    const { normalizeOciConfig } = await import('./oci/config.ts')
    return new OCIResource(normalizeOciConfig(config))
  },
  r2: async (config) => {
    const { R2Resource } = await import('./r2/r2.ts')
    const { normalizeR2Config } = await import('./r2/config.ts')
    return new R2Resource(normalizeR2Config(config))
  },
  hf_buckets: async (config) => {
    const { HfBucketsResource } = await import('./hf_buckets/hf_buckets.ts')
    const { normalizeHfBucketsConfig } = await import('./hf_buckets/config.ts')
    return new HfBucketsResource(normalizeHfBucketsConfig(config))
  },
  hf_datasets: async (config) => {
    const { HfDatasetsResource } = await import('./hf_datasets/hf_datasets.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfDatasetsResource(normalizeHfRepoConfig(config))
  },
  hf_models: async (config) => {
    const { HfModelsResource } = await import('./hf_models/hf_models.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfModelsResource(normalizeHfRepoConfig(config))
  },
  hf_spaces: async (config) => {
    const { HfSpacesResource } = await import('./hf_spaces/hf_spaces.ts')
    const { normalizeHfRepoConfig } = await import('./hf_buckets/config.ts')
    return new HfSpacesResource(normalizeHfRepoConfig(config))
  },
  supabase: async (config) => {
    const { SupabaseResource } = await import('./supabase/supabase.ts')
    const { normalizeSupabaseConfig } = await import('./supabase/config.ts')
    return new SupabaseResource(normalizeSupabaseConfig(config))
  },
  databricks_volume: async (config) => {
    const { DatabricksVolumeResource } = await import('./databricks_volume/databricks_volume.ts')
    const { normalizeDatabricksVolumeConfig } = await import('@struktoai/mirage-core')
    return DatabricksVolumeResource.create(normalizeDatabricksVolumeConfig(config))
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
  postgres: async (config) => {
    const { PostgresResource } = await import('./postgres/postgres.ts')
    const { normalizePostgresConfig } = await import('@struktoai/mirage-core')
    return new PostgresResource(normalizePostgresConfig(config))
  },
  mongodb: async (config) => {
    const { MongoDBResource } = await import('./mongodb/mongodb.ts')
    const { normalizeMongoDBConfig } = await import('@struktoai/mirage-core')
    return new MongoDBResource(normalizeMongoDBConfig(config))
  },
  slack: async (config) => {
    const { SlackResource } = await import('./slack/slack.ts')
    const { normalizeSlackConfig } = await import('./slack/config.ts')
    return new SlackResource(normalizeSlackConfig(config))
  },
  ssh: async (config) => {
    const { SSHResource } = await import('./ssh/ssh.ts')
    const { normalizeSshConfig } = await import('./ssh/config.ts')
    return new SSHResource(normalizeSshConfig(config))
  },
  nextcloud: async (config) => {
    const { NextcloudResource } = await import('./nextcloud/nextcloud.ts')
    const { normalizeNextcloudConfig } = await import('./nextcloud/config.ts')
    return new NextcloudResource(normalizeNextcloudConfig(config))
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
    const { normalizeLinearConfig } = await import('./linear/config.ts')
    return new LinearResource(normalizeLinearConfig(config))
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
    const { normalizeGitHubConfig } = await import('./github/config.ts')
    return GitHubResource.create(normalizeGitHubConfig(config))
  },
  github_ci: async (config) => {
    const { GitHubCIResource } = await import('./github_ci/github_ci.ts')
    const { normalizeGitHubCIConfig } = await import('./github_ci/config.ts')
    return new GitHubCIResource(normalizeGitHubCIConfig(config))
  },
  gdocs: async (config) => {
    const { GDocsResource } = await import('./gdocs/gdocs.ts')
    const { normalizeGDocsConfig } = await import('./gdocs/config.ts')
    return new GDocsResource(normalizeGDocsConfig(config))
  },
  gsheets: async (config) => {
    const { GSheetsResource } = await import('./gsheets/gsheets.ts')
    const { normalizeGSheetsConfig } = await import('./gsheets/config.ts')
    return new GSheetsResource(normalizeGSheetsConfig(config))
  },
  gslides: async (config) => {
    const { GSlidesResource } = await import('./gslides/gslides.ts')
    const { normalizeGSlidesConfig } = await import('./gslides/config.ts')
    return new GSlidesResource(normalizeGSlidesConfig(config))
  },
  gdrive: async (config) => {
    const { GDriveResource } = await import('./gdrive/gdrive.ts')
    const { normalizeGDriveConfig } = await import('./gdrive/config.ts')
    return new GDriveResource(normalizeGDriveConfig(config))
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
    const { normalizeGmailConfig } = await import('./gmail/config.ts')
    return new GmailResource(normalizeGmailConfig(config))
  },
  email: async (config) => {
    const { EmailResource } = await import('./email/email.ts')
    const { normalizeEmailConfig } = await import('./email/config.ts')
    return new EmailResource(normalizeEmailConfig(config))
  },
}

/**
 * Look up the registered names. Lazily-mutated by `register()` so users
 * can extend the registry with custom resources.
 */
export function knownResources(): string[] {
  return Object.keys(REGISTRY).sort()
}

/**
 * Register a custom resource factory under `name`. Existing entries
 * are overwritten, mirroring Python's mutable REGISTRY dict.
 */
export function register(name: string, factory: ResourceFactory): void {
  REGISTRY[name] = factory
}

/**
 * Build a resource instance by registry name. Throws if the name is
 * unknown.
 */
export async function buildResource(
  name: string,
  config: Record<string, unknown> = {},
): Promise<Resource> {
  const factory = REGISTRY[name]
  if (factory === undefined) {
    throw new Error(
      `unknown resource ${JSON.stringify(name)}; known: ${knownResources().join(', ')}`,
    )
  }
  return factory(config)
}
